// Local no-login bridge between the Craftlink page and Minecraft Bedrock.
// Run with: node bridge-server.js
// Keep this on a trusted network. Anyone who can reach port 7331 can run commands.
const http = require('node:http');
const crypto = require('node:crypto');
const PORT = Number(process.env.PORT || 7331);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let minecraft = null;
const browsers = new Set();
function sendFrame(socket, data, opcode = 1) {
  if (socket.destroyed) return;
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let head;
  if (body.length < 126) head = Buffer.from([0x80 | opcode, body.length]);
  else if (body.length < 65536) { head=Buffer.alloc(4); head[0]=0x80|opcode; head[1]=126; head.writeUInt16BE(body.length,2); }
  else { head=Buffer.alloc(10); head[0]=0x80|opcode; head[1]=127; head.writeBigUInt64BE(BigInt(body.length),2); }
  socket.write(Buffer.concat([head,body]));
}
function sendJson(socket, obj) { sendFrame(socket, JSON.stringify(obj)); }
function status() {
  const message=JSON.stringify({type:'bridgeStatus',minecraftConnected:!!minecraft});
  for(const client of browsers) sendFrame(client,message);
}
function parseFrames(socket,onText) {
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=2) {
      const fin=!!(buffer[0]&0x80), opcode=buffer[0]&0x0f, masked=!!(buffer[1]&0x80);
      let length=buffer[1]&0x7f, offset=2;
      if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;}
      else if(length===127){if(buffer.length<10)return;const n=buffer.readBigUInt64BE(2);if(n>1000000n){socket.destroy();return;}length=Number(n);offset=10;}
      const maskBytes=masked?4:0;
      if(buffer.length<offset+maskBytes+length)return;
      const mask=masked?buffer.subarray(offset,offset+4):null; offset+=maskBytes;
      const payload=Buffer.from(buffer.subarray(offset,offset+length));
      buffer=buffer.subarray(offset+length);
      if(mask)for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
      if(opcode===8){sendFrame(socket,Buffer.alloc(0),8);socket.end();return;}
      if(opcode===9){sendFrame(socket,payload,10);continue;}
      if(opcode===1||opcode===0){if(!fin){socket.destroy();return;}onText(payload.toString('utf8'));}
    }
  });
}
function upgrade(req,socket,head) {
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname!=='/minecraft'&&pathname!=='/browser'){socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');return;}
  const key=req.headers['sec-websocket-key'];
  if(!key||req.headers.upgrade?.toLowerCase()!=='websocket'){socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;}
  const accept=crypto.createHash('sha1').update(key+GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  if(head?.length)socket.unshift(head);
  if(pathname==='/minecraft') {
    if(minecraft&&!minecraft.destroyed){sendFrame(socket,'Minecraft is already connected.');socket.end();return;}
    minecraft=socket; console.log('Minecraft connected'); status();
    parseFrames(socket,text=>{let packet;try{packet=JSON.parse(text);}catch{return;}
      if(packet?.header?.messageType==='commandResponse')for(const client of browsers)sendFrame(client,text);
    });
    socket.on('close',()=>{if(minecraft===socket){minecraft=null;console.log('Minecraft disconnected');status();}});
    socket.on('error',()=>{if(minecraft===socket){minecraft=null;status();}});
  } else {
    browsers.add(socket); sendJson(socket,{type:'bridgeStatus',minecraftConnected:!!minecraft}); console.log('Page connected');
    parseFrames(socket,text=>{let packet;try{packet=JSON.parse(text);}catch{return;}
      const command=packet?.body?.commandLine, requestId=packet?.header?.requestId;
      if(packet?.header?.messageType!=='commandRequest'||typeof command!=='string'||!requestId)return;
      if(!minecraft||minecraft.destroyed){sendJson(socket,{header:{version:1,requestId,messageType:'commandResponse',messagePurpose:'commandResponse'},body:{statusCode:-1,statusMessage:'Minecraft is not connected to the bridge.'}});return;}
      if(command.length>2000){sendJson(socket,{header:{version:1,requestId,messageType:'commandResponse',messagePurpose:'commandResponse'},body:{statusCode:-1,statusMessage:'Command is too long.'}});return;}
      sendJson(minecraft,{header:{version:1,requestId,messageType:'commandRequest',messagePurpose:'commandRequest'},body:{version:1,commandLine:command}});
    });
    socket.on('close',()=>{browsers.delete(socket);console.log('Page disconnected');});
    socket.on('error',()=>browsers.delete(socket));
  }
}
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});res.end('Craftlink bridge running. Endpoints: /minecraft and /browser.');});
server.on('upgrade',upgrade);
server.listen(PORT,'0.0.0.0',()=>{
  console.log('Craftlink bridge listening on port '+PORT);
  console.log('Minecraft: ws://<computer-LAN-IP>:'+PORT+'/minecraft');
  console.log('Craftlink page: ws://localhost:'+PORT+'/browser');
  console.log('No login. Trusted network only; do not port-forward this port.');
});
