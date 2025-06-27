const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
const wss = new WebSocket.Server({ noServer: true });

// تخزين الرسائل والأوامر في الذاكرة
const activeDevices = new Map();
const activeClients = new Map();
const lastDeviceMessages = new Map(); // بديل Redis لتخزين بيانات الأجهزة
const lastClientCommands = new Map(); // بديل Redis لتخزين أوامر العملاء

//app.use(express.static(path.join(__dirname, 'public')));

server.on('upgrade', (request, socket, head) => {
  if (request.url === '/ws/device') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// WebSocket للأجهزة
wss.on('connection', (ws, req) => {
  let deviceId = null;

  ws.on('message', async (message) => {
    try {
      if (!deviceId) {
        deviceId = message.toString().trim();

        if (!isValidDeviceId(deviceId)) {
          ws.close(4000, 'ID not valid');
          return;
        }

        activeDevices.set(deviceId, ws);
        console.log(`📡 [${deviceId}] متصل`);

        ws.send(`SERVER: Device not found ${deviceId}`);

        // إرسال آخر رسالة من العملاء (إن وجدت)
        const lastClientMessage = lastClientCommands.get(deviceId);
        if (lastClientMessage) {
          ws.send(`LAST:${lastClientMessage}`);
        }

        return;
      }

      lastDeviceMessages.set(deviceId, message.toString());

      io.to(`device_${deviceId}`).emit('device_data', {
        deviceId,
        data: message.toString(),
        timestamp: new Date().toISOString()
      });

      console.log(`📩 [${deviceId}] بيانات مستلمة`);
    } catch (error) {
      console.error(`❌ خطأ في الجهاز: ${error.message}`);
    }
  });

  ws.on('close', () => {
    if (deviceId) {
      activeDevices.delete(deviceId);
      console.log(`📡 [${deviceId}] فصل الاتصال`);
    }
  });
});

// Socket.IO للعملاء
io.on('connection', (socket) => {
  console.log(`🌐 [${socket.id}] عميل متصل`);
  activeClients.set(socket.id, socket);

  socket.on('subscribe', async (deviceId) => {
    try {
      if (!isValidDeviceId(deviceId)) {
        socket.emit('error', 'Device ID غير صالح');
        return;
      }

      Array.from(socket.rooms)
        .filter(room => room.startsWith('device_'))
        .forEach(room => socket.leave(room));

      socket.join(`device_${deviceId}`);
      console.log(`🎯 [${socket.id}] اشترك في ${deviceId}`);

      const lastDeviceMessage = lastDeviceMessages.get(deviceId);
      if (lastDeviceMessage) {
        socket.emit('device_data', {
          deviceId,
          data: lastDeviceMessage,
          timestamp: 'old',
          isHistory: true
        });
      }

      const isDeviceOnline = activeDevices.has(deviceId);
      socket.emit('device_status', {
        deviceId,
        status: isDeviceOnline ? 'online' : 'offline'
      });
    } catch (error) {
      console.error(`❌ خطأ في الاشتراك: ${error.message}`);
    }
  });

  socket.on('send_command', async ({ deviceId, command }) => {
    try {
      if (!socket.rooms.has(`device_${deviceId}`)) {
        socket.emit('error', 'لم تشترك في هذا الجهاز');
        return;
      }

      if (!isValidCommand(command)) {
        socket.emit('error', 'أمر غير صالح');
        return;
      }

      lastClientCommands.set(deviceId, command);

      const deviceWs = activeDevices.get(deviceId);
      if (deviceWs) {
        deviceWs.send(command);
        console.log(`📤 [${deviceId}] تم إرسال الأمر: ${command}`);
      } else {
        socket.emit('warning', 'الجهاز غير متصل - سيتم إرسال الأمر عند الاتصال');
      }
    } catch (error) {
      console.error(`❌ خطأ في إرسال الأمر: ${error.message}`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🌐 [${socket.id}] عميل قطع الاتصال`);
    activeClients.delete(socket.id);
  });
});

// وظائف مساعدة
function isValidDeviceId(deviceId) {
  return /^ESP32-[1-9][0-9]?$/.test(deviceId);
}

function isValidCommand(command) {
  return /^[A-Z0-9_]{1,20}$/.test(command);
}

// بدء الخادم
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔌 WebSocket ready at ws://localhost:${PORT}/ws/device`);
});

// إغلاق آمن
process.on('SIGINT', () => {
  console.log('⏹️ يتم إيقاف الخادم...');

  activeDevices.forEach((ws, deviceId) => {
    ws.close(1001, 'Server stopping');
    console.log(`📡 [${deviceId}] تم قطع الاتصال`);
  });

  activeClients.forEach((socket, clientId) => {
    socket.disconnect(true);
    console.log(`🌐 [${clientId}] تم فصل العميل`);
  });

  process.exit(0);
});
