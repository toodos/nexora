'use strict';
/**
 * Nexora v2 — server.js
 * WebRTC signaling · Quiz · Chat relay · Canvas sync · Room management
 * Pure in-memory. No database needed.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const https    = require('https');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  pingTimeout:  20000,
  pingInterval: 10000
});

// OpenRouter AI
const OPENROUTER_KEY = "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";
const AI_MODEL = "google/gemini-2.0-flash-001";

app.use(express.static(path.join(__dirname)));

/* ─────────────────────────────────────────────────────────
   IN-MEMORY STORE
───────────────────────────────────────────────────────── */
const MAX_PER_ROOM = 12;

// rooms[id] = { peers: Map, teacherId, locked, chat[], canvas[] }
const rooms       = {};
const quizzes     = {};   // roomId → quiz
const scores      = {};   // roomId → { socketId: pts }
const submissions = {};   // roomId → { qIdx → { socketId: answerIdx } }

/* ─────────────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────────────── */
function getRoom(id) {
  if (!rooms[id]) rooms[id] = { peers: new Map(), teacherId: null, locked: false, chat: [], canvas: [] };
  return rooms[id];
}

function cleanup(id) {
  if (rooms[id] && rooms[id].peers.size === 0) {
    delete rooms[id]; delete quizzes[id]; delete scores[id]; delete submissions[id];
    console.log(`  [cleanup] room "${id}" removed`);
  }
}

function participantList(id) {
  const r = rooms[id]; if (!r) return [];
  return [...r.peers.values()].map(p => ({ socketId: p.socketId, role: p.role, name: p.name, muted: !!p.muted }));
}

function leaderboard(id) {
  const r = rooms[id]; const sc = scores[id] || {}; if (!r) return [];
  return [...r.peers.values()]
    .filter(p => p.role === 'student')
    .map(p => ({ socketId: p.socketId, name: p.name, score: sc[p.socketId] || 0 }))
    .sort((a, b) => b.score - a.score);
}

/* ─────────────────────────────────────────────────────────
   SOCKET EVENTS
───────────────────────────────────────────────────────── */
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  /* JOIN -------------------------------------------------------------------- */
  socket.on('join-room', ({ roomId, role, name }) => {
    try {
      const prev = socket.data.roomId;
      if (prev && prev !== roomId) doLeave(socket, prev);

      const room = getRoom(roomId);
      if (room.locked && !room.peers.has(socket.id)) { socket.emit('room-locked'); return; }
      if (room.peers.size >= MAX_PER_ROOM && !room.peers.has(socket.id)) { socket.emit('room-full'); return; }

      const effectiveRole = room.peers.size === 0 ? 'teacher' : (role || 'student');
      const n = (name || `User ${socket.id.slice(0,4)}`).trim();

      // Prevent duplicate names in same room (cleanup old ghost entries)
      for (const [sid, p] of room.peers.entries()) {
        if (p.name === n && sid !== socket.id) {
          room.peers.delete(sid);
          console.log(`  [cleanup] removed old ghost entry for ${n}`);
        }
      }

      room.peers.set(socket.id, { socketId: socket.id, role: effectiveRole, name: n, muted: false });
      if (effectiveRole === 'teacher') room.teacherId = socket.id;
      if (!scores[roomId]) scores[roomId] = {};
      if (effectiveRole === 'student') scores[roomId][socket.id] = scores[roomId][socket.id] || 0;

      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.name   = n;
      socket.data.role   = effectiveRole;

      console.log(`  [join] ${n} (${effectiveRole}) "${roomId}" [${room.peers.size}]`);

      socket.emit('room-joined', {
        roomId, role: effectiveRole, selfId: socket.id,
        participants: participantList(roomId).filter(p => p.socketId !== socket.id),
        chatHistory:   room.chat,
        canvasStrokes: room.canvas,
        participantCount: room.peers.size
      });

      socket.to(roomId).emit('user-joined', {
        socketId: socket.id, role: effectiveRole, name: n,
        participantCount: room.peers.size
      });

      // Catch-up active quiz
      const quiz = quizzes[roomId];
      if (quiz?.active && quiz.currentIndex >= 0) {
        const q = quiz.questions[quiz.currentIndex];
        socket.emit('quiz-question', { question: q.text, options: q.options, index: quiz.currentIndex, total: quiz.questions.length });
      }
    } catch(e) { console.error('[join-room]', e.message); }
  });

  /* WEBRTC MESH ------------------------------------------------------------- */
  // Include sender name+role so receiver can create peer entry without a separate lookup
  socket.on('offer', ({ to, offer }) => {
    if (!to) return;
    io.to(to).emit('offer', {
      from:     socket.id,
      fromName: socket.data.name || `User-${socket.id.slice(0,4)}`,
      fromRole: socket.data.role || 'student',
      offer
    });
  });
  socket.on('answer', ({ to, answer }) => {
    if (!to) return;
    io.to(to).emit('answer', {
      from:     socket.id,
      fromName: socket.data.name || `User-${socket.id.slice(0,4)}`,
      fromRole: socket.data.role || 'student',
      answer
    });
  });
  socket.on('ice-candidate', ({ to, candidate }) => {
    if (to) io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  /* SCREEN SHARE ------------------------------------------------------------ */
  socket.on('screen-share-started', () => { const r=socket.data.roomId; if(r) socket.to(r).emit('peer-screen-share-started',{from:socket.id}); });
  socket.on('screen-share-stopped', () => { const r=socket.data.roomId; if(r) socket.to(r).emit('peer-screen-share-stopped',{from:socket.id}); });

  /* CHAT -------------------------------------------------------------------- */
  socket.on('chat-message', ({ text }) => {
    const roomId = socket.data.roomId;
    const room   = rooms[roomId];
    if (!room || !text?.trim()) return;
    const msg = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      senderId: socket.id, senderName: socket.data.name || 'User',
      role: socket.data.role || 'student',
      text: text.trim().slice(0, 500), ts: Date.now()
    };
    room.chat.push(msg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(roomId).emit('chat-message', msg);
  });

  /* CANVAS ------------------------------------------------------------------ */
  socket.on('canvas-stroke', (data) => {
    const roomId = socket.data.roomId;
    const room   = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    room.canvas.push(data);
    if (room.canvas.length > 3000) room.canvas.splice(0, 500);
    socket.to(roomId).emit('canvas-stroke', data);
  });

  socket.on('canvas-clear', () => {
    const roomId = socket.data.roomId;
    const room   = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    room.canvas = [];
    io.to(roomId).emit('canvas-clear');
  });

  socket.on('canvas-undo', () => {
    const roomId = socket.data.roomId;
    const room   = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    // Remove strokes from last strokeId group
    if (room.canvas.length > 0) {
      const lastId = room.canvas[room.canvas.length - 1]?.strokeId;
      while (room.canvas.length > 0 && room.canvas[room.canvas.length-1]?.strokeId === lastId) {
        room.canvas.pop();
      }
    }
    socket.to(roomId).emit('canvas-undo');
  });

  /* ROOM MANAGEMENT --------------------------------------------------------- */
  socket.on('lock-room', () => {
    const roomId = socket.data.roomId; const room = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    room.locked = !room.locked;
    io.to(roomId).emit('room-lock-changed', { locked: room.locked });
  });

  socket.on('kick-participant', ({ targetId }) => {
    const roomId = socket.data.roomId; const room = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    const ts = io.sockets.sockets.get(targetId);
    if (ts) { ts.emit('kicked'); doLeave(ts, roomId); }
  });

  socket.on('mute-all', () => {
    const roomId = socket.data.roomId; const room = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    room.peers.forEach(p => { if (p.role === 'student') p.muted = true; });
    socket.to(roomId).emit('force-mute');
  });

  /* QUIZ -------------------------------------------------------------------- */
  socket.on('create-quiz', ({ roomId, questions }) => {
    const room = rooms[roomId];
    if (!room || room.teacherId !== socket.id) return;
    quizzes[roomId] = { questions, currentIndex: -1, active: false, firstCorrect: null };
    scores[roomId] = {}; submissions[roomId] = {};
    room.peers.forEach(p => { if(p.role==='student') scores[roomId][p.socketId]=0; });
    socket.emit('quiz-created', { total: questions.length });
  });

  socket.on('start-quiz', ({ roomId }) => {
    const room=rooms[roomId]; const quiz=quizzes[roomId];
    if (!room||!quiz||room.teacherId!==socket.id) return;
    quiz.active=true; quiz.currentIndex=0; quiz.firstCorrect=null;
    submissions[roomId]={0:{}};
    const q=quiz.questions[0];
    io.to(roomId).emit('quiz-question',{question:q.text,options:q.options,index:0,total:quiz.questions.length});
  });

  socket.on('next-question', ({ roomId }) => {
    const room=rooms[roomId]; const quiz=quizzes[roomId];
    if (!room||!quiz||room.teacherId!==socket.id) return;
    quiz.currentIndex++; quiz.firstCorrect=null;
    if (quiz.currentIndex>=quiz.questions.length) {
      quiz.active=false;
      io.to(roomId).emit('quiz-ended',{leaderboard:leaderboard(roomId)}); return;
    }
    submissions[roomId][quiz.currentIndex]={};
    const q=quiz.questions[quiz.currentIndex];
    io.to(roomId).emit('quiz-question',{question:q.text,options:q.options,index:quiz.currentIndex,total:quiz.questions.length});
  });

  socket.on('submit-answer', ({ roomId, answerIndex }) => {
    const quiz=quizzes[roomId];
    if (!quiz||!quiz.active) return;
    const qi=quiz.currentIndex;
    if (!submissions[roomId]) submissions[roomId]={};
    if (!submissions[roomId][qi]) submissions[roomId][qi]={};
    if (submissions[roomId][qi][socket.id]!==undefined) return;
    submissions[roomId][qi][socket.id]=answerIndex;
    const correct=quiz.questions[qi].correct;
    const right=answerIndex===correct;
    let pts=0;
    if (right) {
      pts=10;
      if (!quiz.firstCorrect){quiz.firstCorrect=socket.id;pts+=5;}
      scores[roomId][socket.id]=(scores[roomId][socket.id]||0)+pts;
    }
    socket.emit('answer-result',{correct:right,correct_index:correct,points:pts});
    io.to(roomId).emit('update-leaderboard',{leaderboard:leaderboard(roomId),questionIndex:qi});
  });

  socket.on('end-quiz', ({ roomId }) => {
    const room=rooms[roomId]; const quiz=quizzes[roomId];
    if (!room||!quiz||room.teacherId!==socket.id) return;
    quiz.active=false;
    io.to(roomId).emit('quiz-ended',{leaderboard:leaderboard(roomId)});
  });

  socket.on('reset-quiz', ({ roomId }) => {
    const room=rooms[roomId];
    if (!room||room.teacherId!==socket.id) return;
    delete quizzes[roomId]; delete scores[roomId]; delete submissions[roomId];
    io.to(roomId).emit('quiz-reset');
  });

  /* AI ASSISTANT (OpenRouter) ---------------------------------------------- */
  socket.on('ai-chat', async ({ prompt }) => {
    try {
      if (!OPENROUTER_KEY) {
        console.error("AI Error: OPENROUTER_KEY is missing");
        socket.emit('ai-response', { text: "⚠️ AI service is not configured.", error: true });
        return;
      }

      const data = JSON.stringify({
        model: AI_MODEL,
        messages: [{ role: "user", content: prompt }]
      });

      const options = {
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${OPENROUTER_KEY}`,
          'HTTP-Referer': 'http://localhost:3000',
          'X-Title': 'Nexora'
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.choices && json.choices[0]) {
              socket.emit('ai-response', { text: json.choices[0].message.content });
            } else {
              console.error("OpenRouter Error:", json);
              socket.emit('ai-response', { text: "I'm having trouble thinking right now. Please try again later.", error: true });
            }
          } catch (e) {
            console.error("Parse Error:", e);
            socket.emit('ai-response', { text: "Error processing AI response.", error: true });
          }
        });
      });

      req.on('error', (error) => {
        console.error("Request Error:", error);
        socket.emit('ai-response', { text: "AI Request failed.", error: true });
      });

      req.write(data);
      req.end();

    } catch (error) {
      console.error("General AI Error:", error);
      socket.emit('ai-response', { text: "Unexpected error with AI Assistant.", error: true });
    }
  });

  /* DISCONNECT -------------------------------------------------------------- */
  socket.on('disconnecting', () => { const r=socket.data.roomId; if(r) doLeave(socket,r); });
  socket.on('disconnect', () => { console.log(`[-] ${socket.id}`); });
});

/* ─────────────────────────────────────────────────────────
   LEAVE
───────────────────────────────────────────────────────── */
function doLeave(socket, roomId) {
  const room = rooms[roomId]; if (!room) return;
  const leaving = room.peers.get(socket.id);
  room.peers.delete(socket.id);
  socket.leave(roomId);
  delete socket.data.roomId;

  if (room.teacherId === socket.id) {
    const next = [...room.peers.values()][0];
    if (next) {
      room.teacherId = next.socketId; next.role = 'teacher';
      io.to(next.socketId).emit('promoted-to-teacher');
      socket.to(roomId).emit('teacher-changed', { newTeacherId: next.socketId, name: next.name });
    } else { room.teacherId = null; }
  }

  socket.to(roomId).emit('user-left', {
    socketId: socket.id, name: leaving?.name || '',
    participantCount: room.peers.size
  });
  cleanup(roomId);
}

/* ─────────────────────────────────────────────────────────
   START
───────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀  Nexora v2 → http://localhost:${PORT}\n`);
});