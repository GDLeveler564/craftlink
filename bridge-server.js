// Bridge between the Craftlink page and Minecraft Bedrock.
// Run with: node bridge-server.js
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 7331);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

let minecraft = null;
const browsers = new Set();

function sendFrame(socket, data, opcode = 1) {
  if (!socket || socket.destroyed || !socket.writable) return;
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let head;
  if (body.length < 126) {
    head = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(body.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(body.length), 2);
  }
  socket.write(Buffer.concat([head, body]));
}

function sendJson(socket, obj) {
  sendFrame(socket, JSON.stringify(obj), 1);
}

function broadcastStatus() {
  const message = JSON.stringify({
    type: 'bridgeStatus',
    minecraftConnected: Boolean(minecraft && !minecraft.destroyed),
  });
  for (const client of browsers) {
    sendFrame(client, message, 1);
  }
}

function parseFrames(socket, onText) {
  let buffer = Buffer.alloc(0);

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = Boolean(buffer[0] & 0x80);
      const opcode = buffer[0] & 0x0f;
      const masked = Boolean(buffer[1] & 0x80);
      let length = buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const n = buffer.readBigUInt64BE(2);
        if (n > 2000000n) {
          socket.destroy();
          return;
        }
        length = Number(n);
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (buffer.length < offset + maskBytes + length) return;

      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskBytes;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      buffer = buffer.subarray(offset + length);

      if (mask) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }

      if (opcode === 8) {
        // Echo 2-byte status code if valid (1000-4999, excluding 1004-1006, 1015), else empty close
        let closePayload = Buffer.alloc(0);
        if (payload.length >= 2) {
          const code = payload.readUInt16BE(0);
          const validCode =
            code >= 1000 &&
            code <= 4999 &&
            code !== 1004 &&
            code !== 1005 &&
            code !== 1006 &&
            code !== 1015;
          if (validCode) {
            closePayload = payload.subarray(0, 2);
          }
        }
        sendFrame(socket, closePayload, 8);
        socket.end();
        return;
      }

      if (opcode === 9) {
        sendFrame(socket, payload, 10); // Pong
        continue;
      }

      if (opcode === 1 || opcode === 0) {
        if (!fin) {
          socket.destroy();
          return;
        }
        onText(payload.toString('utf8'));
      }
    }
  };

  socket.on('data', onData);
  socket.once('close', () => {
    buffer = Buffer.alloc(0);
    socket.removeListener('data', onData);
  });
}

function upgrade(req, socket, head) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname !== '/minecraft' && pathname !== '/browser') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return;
  }

  const accept = crypto
    .createHash('sha1')
    .update(key + GUID)
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n'
  );

  if (head?.length) socket.unshift(head);

  if (pathname === '/minecraft') {
    if (minecraft && !minecraft.destroyed) {
      sendFrame(socket, 'Minecraft is already connected.', 1);
      socket.end();
      return;
    }

    minecraft = socket;
    console.log('Minecraft connected');
    broadcastStatus();

    parseFrames(socket, (text) => {
      let packet;
      try {
        packet = JSON.parse(text);
      } catch {
        return;
      }
      const purpose = packet?.header?.messagePurpose;
      const type = packet?.header?.messageType;
      if (type === 'commandResponse' || purpose === 'commandResponse') {
        for (const client of browsers) {
          sendFrame(client, text, 1);
        }
      }
    });

    const cleanupMc = () => {
      if (minecraft === socket) {
        minecraft = null;
        console.log('Minecraft disconnected');
        broadcastStatus();
      }
    };
    socket.once('close', cleanupMc);
    socket.once('error', cleanupMc);
  } else {
    browsers.add(socket);
    sendJson(socket, {
      type: 'bridgeStatus',
      minecraftConnected: Boolean(minecraft && !minecraft.destroyed),
    });
    console.log('Page connected');

    parseFrames(socket, (text) => {
      let packet;
      try {
        packet = JSON.parse(text);
      } catch {
        return;
      }
      const command = packet?.body?.commandLine;
      const requestId = packet?.header?.requestId;
      if (
        packet?.header?.messageType !== 'commandRequest' ||
        typeof command !== 'string' ||
        !requestId
      ) {
        return;
      }

      if (!minecraft || minecraft.destroyed) {
        sendJson(socket, {
          header: {
            version: 1,
            requestId,
            messageType: 'commandResponse',
            messagePurpose: 'commandResponse',
          },
          body: {
            statusCode: -1,
            statusMessage: 'Minecraft is not connected to the bridge.',
          },
        });
        return;
      }

      if (command.length > 2000) {
        sendJson(socket, {
          header: {
            version: 1,
            requestId,
            messageType: 'commandResponse',
            messagePurpose: 'commandResponse',
          },
          body: {
            statusCode: -1,
            statusMessage: 'Command is too long.',
          },
        });
        return;
      }

      sendJson(minecraft, {
        header: {
          version: 1,
          requestId,
          messageType: 'commandRequest',
          messagePurpose: 'commandRequest',
        },
        body: {
          version: 1,
          commandLine: command,
        },
      });
    });

    const cleanupBrowser = () => browsers.delete(socket);
    socket.once('close', cleanupBrowser);
    socket.once('error', cleanupBrowser);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Craftlink bridge running. Endpoints: /minecraft and /browser.');
});

server.on('upgrade', upgrade);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Craftlink bridge listening on port ' + PORT);
  console.log('Minecraft: ws://<computer-LAN-IP>:' + PORT + '/minecraft');
  console.log('Craftlink page: ws://localhost:' + PORT + '/browser');
});
