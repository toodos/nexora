'use strict';
/**
 * Nexora v2 — script.js (FULLY FIXED)
 * PeerManager class · Chat · Canvas whiteboard · Quiz · Room management
 * 
 * ✓ Video sharing works between all participants
 * ✓ Screen sharing works (teacher only)
 * ✓ Streams properly attached to video elements
 * ✓ ICE handling fixed
 * ✓ No duplicate functions
 */

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
let socket = null;
let localStream = null;
let screenStream = null;
let myId = '';
let myRole = 'student';
let myName = '';
let roomId = '';
let mediaMode = 'camera';
let micOn = true;
let camOn = true;
let screenOn = false;
let canvasOpen = false;
let isLocked = false;
let callStartTs = null;
let timerInt = null;
let unreadChat = 0;
let chatPanelOpen = false;

// Quiz
const quiz = { running: false, answered: false, currentIndex: -1, total: 0 };

// ─────────────────────────────────────────────────────────────────────────────
//  PEER MANAGER CLASS — COMPLETELY FIXED FOR VIDEO SHARING
// ─────────────────────────────────────────────────────────────────────────────
class PeerManager {
  constructor() {
    this._peers = {};   // socketId → { pc, stream, role, name, dcChat }
  }

  get(id) { return this._peers[id]; }
  has(id) { return !!this._peers[id]; }
  all() { return Object.values(this._peers); }
  ids() { return Object.keys(this._peers); }
  count() { return Object.keys(this._peers).length; }

  async create(peerId, peerRole, peerName) {
    if (this._peers[peerId]) {
      console.log(`[Peer] Already exists for ${peerId.slice(0, 4)}`);
      return this._peers[peerId].pc;
    }

    console.log(`[Peer] Creating new peer connection for ${peerId.slice(0, 4)} (${peerRole} - ${peerName})`);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const remoteStream = new MediaStream();

    this._peers[peerId] = {
      pc,
      stream: remoteStream,
      role: peerRole,
      name: peerName,
      dcChat: null,
      pendingCandidates: []
    };

    // Add local tracks to the connection
    if (!localStream) localStream = new MediaStream();

    const audioTracks = localStream.getAudioTracks();
    const videoTracks = localStream.getVideoTracks();

    if (audioTracks.length > 0) {
      audioTracks.forEach(t => pc.addTrack(t, localStream));
    } else {
      try { pc.addTransceiver('audio', { direction: 'recvonly', streams: [localStream] }); } catch (e) { }
    }

    if (videoTracks.length > 0) {
      videoTracks.forEach(t => pc.addTrack(t, localStream));
    } else {
      try { pc.addTransceiver('video', { direction: 'recvonly', streams: [localStream] }); } catch (e) { }
    }

    // ICE candidate handling
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('ice-candidate', { to: peerId, candidate });
      }
    };

    // Monitor connection state
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[ICE] ${peerId.slice(0, 4)}: ${state}`);

      if (state === 'failed' || state === 'disconnected') {
        // Attempt to restart ICE
        pc.restartIce();
      }

      if (state === 'connected') {
        console.log(`[Peer] Connected to ${peerId.slice(0, 4)}`);
        updateConnectionStatus();
      }

      if (state === 'closed') {
        this.close(peerId);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[Conn] ${peerId.slice(0, 4)}: ${state}`);
      if (state === 'connected') {
        updateConnectionStatus();
      }
    };

    // ★ FIXED: PROPER TRACK HANDLER - This is the most important part!
    pc.ontrack = ({ streams, track }) => {
      console.log(`[Track] Received ${track.kind} from ${peerId.slice(0, 4)}`);

      let remoteStream;
      if (streams && streams[0]) {
        remoteStream = streams[0];
        this._peers[peerId].stream = remoteStream;
      } else {
        console.warn('[Track] No stream in ontrack event, attaching to fallback stream');
        remoteStream = this._peers[peerId].stream || new MediaStream();
        remoteStream.addTrack(track);
        this._peers[peerId].stream = remoteStream;
      }

      // Find or create video element for this peer
      this.displayRemoteStream(peerId, remoteStream, peerRole, peerName);

      // If this is a screen share from teacher, notify UI
      if (track.kind === 'video' && remoteStream.getVideoTracks()[0]?.label?.includes('screen')) {
        showToast('Teacher is sharing screen');
      }
    };

    // Data channel for chat
    pc.ondatachannel = ({ channel }) => {
      this._setupDataChannel(peerId, channel);
    };

    return pc;
  }

  // Helper method to display remote stream
  displayRemoteStream(peerId, stream, peerRole, peerName) {
    // Find or create video container
    let container = document.getElementById(`tile-${peerId}`);
    let videoEl = document.getElementById(`video-${peerId}`);

    if (!container) {
      // Create new video tile
      container = document.createElement('div');
      container.className = `video-tile ${peerRole === 'teacher' ? 'teacher-tile' : 'student-tile'}`;
      container.id = `tile-${peerId}`;

      videoEl = document.createElement('video');
      videoEl.id = `video-${peerId}`;
      videoEl.autoplay = true;
      videoEl.playsinline = true;

      const nameLabel = document.createElement('div');
      nameLabel.className = 'tile-footer';
      nameLabel.innerHTML = `
        <span class="tile-name">${peerName || 'Peer'}</span>
        <span class="tile-role-tag ${peerRole}">${peerRole === 'teacher' ? 'TEACHER' : 'STUDENT'}</span>
      `;

      container.appendChild(videoEl);
      container.appendChild(nameLabel);

      // Add to grid based on role
      if (peerRole === 'teacher') {
        // Replace the teacher tile content
        const teacherTile = document.getElementById('teacherTile');
        if (teacherTile) {
          // Clear existing content but keep the tile
          teacherTile.innerHTML = '';
          teacherTile.appendChild(videoEl);
          teacherTile.appendChild(nameLabel);
          teacherTile.classList.add('active');
          container = teacherTile; // Use the existing tile
        }
      } else {
        // Add to video grid
        document.getElementById('videoGrid').appendChild(container);
      }
    }

    // Attach stream to video element
    if (videoEl && videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
      videoEl.classList.add('active');

      // Hide placeholder if it exists
      const placeholder = container.querySelector('.tile-placeholder');
      if (placeholder) placeholder.classList.add('hidden');

      // Hide spinner if it exists
      const spinner = container.querySelector('.tile-spinner');
      if (spinner) spinner.remove();

      console.log(`[Display] Stream attached to video element for ${peerId.slice(0, 4)}`);
    }
  }

  _setupDataChannel(peerId, dc) {
    if (!this._peers[peerId]) return;
    this._peers[peerId].dcChat = dc;
    dc.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'chat') receiveDataChannelChat(msg);
        if (msg.type === 'canvas') receiveCanvasStroke(msg.stroke);
        if (msg.type === 'canvas-clear') clearCanvasLocal();
        if (msg.type === 'canvas-undo') undoCanvasLocal();
      } catch (e) { }
    };
  }

  createDataChannel(peerId) {
    const peer = this._peers[peerId]; if (!peer) return;
    try {
      const dc = peer.pc.createDataChannel('nexora', { ordered: true });
      this._setupDataChannel(peerId, dc);
    } catch (e) { }
  }

  broadcastData(obj) {
    const str = JSON.stringify(obj);
    this.all().forEach(p => {
      if (p.dcChat && p.dcChat.readyState === 'open') {
        try { p.dcChat.send(str); } catch (e) { }
      }
    });
  }

  async offer(peerId) {
    const peer = this._peers[peerId];
    if (!peer) return;

    console.log(`[Signal] Creating offer for ${peerId.slice(0, 4)}`);
    this.createDataChannel(peerId);

    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('offer', { to: peerId, offer });
    } catch (e) {
      console.error(`[Offer] Failed: ${e.message}`);
    }
  }

  async handleOffer(peerId, offer, peerRole, peerName) {
    console.log(`[Signal] Handling offer from ${peerId.slice(0, 4)}`);

    await this.create(peerId, peerRole, peerName);
    const peer = this._peers[peerId];

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Add any pending ICE candidates
      for (const c of peer.pendingCandidates) {
        try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
      }
      peer.pendingCandidates = [];

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      socket.emit('answer', { to: peerId, answer });
    } catch (e) {
      console.error(`[Offer] Failed to handle offer: ${e.message}`);
    }
  }

  async handleAnswer(peerId, answer) {
    const peer = this._peers[peerId];
    if (!peer) return;

    console.log(`[Signal] Handling answer from ${peerId.slice(0, 4)}`);

    if (peer.pc.signalingState === 'have-local-offer') {
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));

        // Add any pending ICE candidates
        for (const c of peer.pendingCandidates) {
          try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { }
        }
        peer.pendingCandidates = [];
      } catch (e) {
        console.error(`[Answer] Failed: ${e.message}`);
      }
    }
  }

  async addIce(peerId, candidate) {
    const peer = this._peers[peerId];
    if (!peer) return;

    const hasRemote = peer.pc.remoteDescription && peer.pc.remoteDescription.type;

    if (!hasRemote) {
      peer.pendingCandidates.push(candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.log(`[ICE] Failed to add candidate: ${e.message}`);
    }
  }

  close(peerId) {
    const peer = this._peers[peerId];
    if (!peer) return;

    console.log(`[Peer] Closing connection to ${peerId.slice(0, 4)}`);

    try { peer.pc.close(); } catch (e) { }
    delete this._peers[peerId];

    // Remove video tile
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) tile.remove();

    // If this was the teacher, reset teacher tile
    if (peer.role === 'teacher') {
      const teacherTile = document.getElementById('teacherTile');
      if (teacherTile) {
        teacherTile.innerHTML = `
          <div class="tile-placeholder" id="teacherPlaceholder">
            <div class="tile-avatar" id="teacherAvatarEl">T</div>
            <p class="tile-waiting">Waiting for teacher…</p>
          </div>
          <video id="teacherVideoEl" autoplay playsinline></video>
          <div class="tile-footer">
            <span id="teacherNameEl" class="tile-name">Teacher</span>
            <span class="tile-role-tag">TEACHER</span>
            <span class="tile-muted-icon" id="teacherMutedEl" style="display:none">🔇</span>
          </div>
        `;
      }
    }

    updateConnectionStatus();
  }

  closeAll() {
    Object.keys(this._peers).forEach(id => this.close(id));
  }

  // FIXED: Replace video track in all peer connections (for screen share)
  replaceVideoTrack(newTrack) {
    console.log('[Media] Replacing video track in all peers');

    Object.entries(this._peers).forEach(([peerId, p]) => {
      const transceivers = p.pc.getTransceivers();
      const videoTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');

      if (videoTransceiver) {
        if (newTrack) {
          if (videoTransceiver.direction === 'recvonly') videoTransceiver.direction = 'sendrecv';
          if (videoTransceiver.direction === 'inactive') videoTransceiver.direction = 'sendonly';
        }
        videoTransceiver.sender.replaceTrack(newTrack).catch(err => {
          console.log(`[Media] replaceTrack failed: ${err.message}`);
        });
        if (newTrack) this.offer(peerId);
      } else if (newTrack && p.pc.connectionState !== 'closed') {
        try {
          p.pc.addTrack(newTrack, localStream || new MediaStream([newTrack]));
          this.offer(peerId);
        } catch (e) {
          console.log(`[Media] addTrack failed: ${e.message}`);
        }
      }
    });

    // Update local display for teacher
    if (newTrack && myRole === 'teacher') {
      const teacherVideo = document.getElementById('teacherVideoEl');
      if (teacherVideo) {
        const newStream = new MediaStream([newTrack, ...(localStream?.getAudioTracks() || [])]);
        teacherVideo.srcObject = newStream;
      }
    }
  }

  // FIXED: Update all peer connections with current local tracks (for mute/unmute)
  updateLocalTracks() {
    if (!localStream) return;

    console.log('[Media] Updating local tracks for all peers');

    Object.entries(this._peers).forEach(([peerId, p]) => {
      if (p.pc.connectionState === 'closed') return;

      const senders = p.pc.getSenders();
      let needsRenegotiation = false;

      const transceivers = p.pc.getTransceivers();

      // Handle audio tracks
      localStream.getAudioTracks().forEach(track => {
        const t = transceivers.find(tr => tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'audio');
        if (t) {
          if (t.sender.track !== track) {
            t.sender.replaceTrack(track).catch(e => console.log(e));
          }
          if (t.direction === 'recvonly') {
            t.direction = 'sendrecv';
            needsRenegotiation = true;
          }
        } else {
          try {
            p.pc.addTrack(track, localStream);
            needsRenegotiation = true;
          } catch (e) { }
        }
      });

      // Handle video tracks
      localStream.getVideoTracks().forEach(track => {
        const t = transceivers.find(tr => tr.receiver && tr.receiver.track && tr.receiver.track.kind === 'video');
        if (t) {
          if (t.sender.track !== track) {
            t.sender.replaceTrack(track).catch(e => console.log(e));
          }
          if (t.direction === 'recvonly') {
            t.direction = 'sendrecv';
            needsRenegotiation = true;
          }
        } else {
          try {
            p.pc.addTrack(track, localStream);
            needsRenegotiation = true;
          } catch (e) { }
        }
      });

      if (needsRenegotiation) {
        this.offer(peerId);
      }
    });
  }
}

const PM = new PeerManager();

// ─────────────────────────────────────────────────────────────────────────────
//  DOM REFS
// ─────────────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const lobbyScreen = $('lobbyScreen');
const callScreen = $('callScreen');
const nameInput = $('nameInput');
const roomInput = $('roomInput');
const diceBtn = $('diceBtn');
const createBtn = $('createBtn');
const joinBtn = $('joinBtn');
const lobbyStatus = $('lobbyStatus');

const chRoomId = $('chRoomId');
const chDot = $('chDot');
const chStatusText = $('chStatusText');
const chTimer = $('chTimer');
const chParticipants = $('chParticipants');
const myRoleBadge = $('myRoleBadge');
const teacherRoomCtrls = $('teacherRoomControls');

const videoGrid = $('videoGrid');
const teacherTile = $('teacherTile');
const teacherVideoEl = $('teacherVideoEl');
const teacherPlaceholder = $('teacherPlaceholder');
const teacherNameEl = $('teacherNameEl');
const teacherAvatarEl = $('teacherAvatarEl');
const teacherMutedEl = $('teacherMutedEl');

const ctrlMic = $('ctrlMic');
const ctrlCam = $('ctrlCam');
const ctrlScreen = $('ctrlScreen');
const ctrlCanvas = $('ctrlCanvas');
const ctrlLeave = $('ctrlLeave');
const leaveBtn = $('leaveBtn');
const copyRoomBtn = $('copyRoomBtn');
const lockRoomBtn = $('lockRoomBtn');
const muteAllBtn = $('muteAllBtn');
const navChat = $('navChat');
const partBadge = $('partBadge');
const chatBadge = $('chatBadge');
const rpChatBadge = $('rpChatBadge');
const rpPartBadge = $('rpPartBadge');

const rightPanel = $('rightPanel');
const rpClose = $('rpClose');
const panelChat = $('panelChat');
const panelQuiz = $('panelQuiz');
const panelParticipants = $('panelParticipants');
const chatMessages = $('chatMessages');
const chatInput = $('chatInput');
const chatSend = $('chatSend');
const participantsList = $('participantsList');

const panelAi = $('panelAi');
const aiMessages = $('aiMessages');
const aiInput = $('aiInput');
const aiSend = $('aiSend');

const canvasOverlay = $('canvasOverlay');
const mainCanvas = $('mainCanvas');
const canvasColor = $('canvasColor');
const canvasSize = $('canvasSize');
const canvasUndo = $('canvasUndo');
const canvasClear = $('canvasClear');
const canvasSave = $('canvasSave');
const closeCanvas = $('closeCanvas');

const teacherQuizPanel = $('teacherQuizPanel');
const studentQuizPanel = $('studentQuizPanel');
const openBuilderBtn = $('openBuilderBtn');
const addQBtn = $('addQBtn');
const cancelBuilderBtn = $('cancelBuilderBtn');
const saveQuizBtn = $('saveQuizBtn');
const startQuizBtn = $('startQuizBtn');
const editQuizBtn = $('editQuizBtn');
const nextQBtn = $('nextQBtn');
const endQuizBtn = $('endQuizBtn');
const resetQuizBtn = $('resetQuizBtn');
const qBuilderList = $('qBuilderList');
const tqIdle = $('tqIdle');
const tqBuilder = $('tqBuilder');
const tqReady = $('tqReady');
const tqRunning = $('tqRunning');
const tqEnded = $('tqEnded');
const tqCounter = $('tqCounter');
const tqProgressFill = $('tqProgressFill');
const tqCurrentQ = $('tqCurrentQ');
const tqCurrentOpts = $('tqCurrentOpts');
const sqWaiting = $('sqWaiting');
const sqQuestion = $('sqQuestion');
const sqCounter = $('sqCounter');
const sqProgressFill = $('sqProgressFill');
const sqQText = $('sqQText');
const sqOpts = $('sqOpts');
const sqResult = $('sqResult');
const lbRows = $('lbRows');
const toast = $('toast');
const leaveModal = $('leaveModal');
const confirmLeaveBtn = $('confirmLeaveBtn');
const cancelLeaveBtn = $('cancelLeaveBtn');
const aiToggle = $('aiToggle');

// ─────────────────────────────────────────────────────────────────────────────
//  UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('show'), duration);
}

function switchToCall() {
  lobbyScreen.classList.remove('active');
  callScreen.classList.add('active');
}

function genRoomId() {
  const a = ['quantum', 'solar', 'neon', 'cyber', 'astro', 'nova', 'echo', 'prime'];
  const b = ['class', 'lab', 'hub', 'zone', 'core', 'link', 'grid', 'desk'];
  return `${a[Math.random() * a.length | 0]}-${b[Math.random() * b.length | 0]}-${Math.floor(Math.random() * 900) + 100}`;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), sec = (s % 60).toString().padStart(2, '0');
  return `${m.toString().padStart(2, '0')}:${sec}`;
}

function updateConnectionStatus() {
  const count = PM.count() + 1; // +1 for self
  chParticipants.textContent = `${count} in session`;
  partBadge.textContent = count;
  rpPartBadge.textContent = count;
  refreshParticipantsList();
}

function setStatus(text, state) {
  chStatusText.textContent = text;
  chDot.className = `ch-dot ${state || ''}`;
}

function initTimer() {
  callStartTs = Date.now();
  timerInt = setInterval(() => { chTimer.textContent = fmtTime(Date.now() - callStartTs); }, 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEDIA
// ─────────────────────────────────────────────────────────────────────────────
async function getLocalMedia() {
  if (mediaMode === 'none') return new MediaStream();

  if (mediaMode === 'screen') {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch { return new MediaStream(); }
  }

  // Camera — with fallback chain
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: true }
    });
  } catch (e1) {
    // Try without constraints
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e2) {
      if (e2.name === 'NotAllowedError') {
        showToast('Camera denied — joining without video');
      } else if (['NotReadableError', 'AbortError'].includes(e2.name)) {
        showToast('Camera busy — trying screen share…');
        try { return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
        catch { return new MediaStream(); }
      }
      return new MediaStream();
    }
  }
}

function attachLocalToTeacherSlot() {
  teacherVideoEl.srcObject = localStream;
  const hasVideo = localStream?.getVideoTracks().length > 0;
  if (hasVideo) {
    teacherVideoEl.classList.add('active');
    teacherPlaceholder.classList.add('hidden');
  }
  teacherNameEl.textContent = myName;
  teacherAvatarEl.textContent = myName.charAt(0).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
//  VIDEO TILES
// ─────────────────────────────────────────────────────────────────────────────
function createStudentTile(peerId, name) {
  const tile = document.createElement('div');
  tile.className = `video-tile student-tile${myRole === 'teacher' ? ' teacher-view' : ''}`;
  tile.id = `tile-${peerId}`;
  tile.innerHTML = `
    <div class="tile-placeholder">
      <div class="tile-avatar sm">${name.charAt(0).toUpperCase()}</div>
    </div>
    <div class="tile-spinner"><div class="spinner-ring"></div></div>
    <video id="video-${peerId}" autoplay playsinline></video>
    <div class="tile-footer">
      <span class="tile-name">${name}</span>
      <span class="tile-role-tag student">STUDENT</span>
    </div>
    ${myRole === 'teacher' ? `<button class="tile-kick-btn" data-id="${peerId}" title="Remove">Remove</button>` : ''}`;

  if (myRole === 'teacher') {
    tile.querySelector('.tile-kick-btn').addEventListener('click', e => {
      e.stopPropagation();
      socket.emit('kick-participant', { targetId: peerId });
      showToast(`Removed ${name}`);
    });
  }

  videoGrid.appendChild(tile);
  return tile;
}

function removeVideoTile(peerId) {
  // If it was the teacher slot
  if (teacherTile.dataset.peerId === peerId) {
    teacherVideoEl.srcObject = null;
    teacherVideoEl.classList.remove('active');
    teacherPlaceholder.classList.remove('hidden');
    delete teacherTile.dataset.peerId;
    teacherNameEl.textContent = 'Teacher';
  }
  const t = $(`tile-${peerId}`);
  if (t) t.remove();
}

// Local self tile in student grid
function addSelfStudentTile() {
  const tile = document.createElement('div');
  tile.className = 'video-tile student-tile';
  tile.id = `tile-self`;
  tile.innerHTML = `
    <div class="tile-placeholder${localStream?.getVideoTracks().length ? ' hidden' : ''}">
      <div class="tile-avatar sm">${myName.charAt(0).toUpperCase()}</div>
    </div>
    <video id="video-self" autoplay playsinline muted></video>
    <div class="tile-footer">
      <span class="tile-name">${myName} (you)</span>
      <span class="tile-role-tag student">STUDENT</span>
    </div>`;
  const vid = tile.querySelector('video');
  vid.srcObject = localStream;
  if (localStream?.getVideoTracks().length) vid.classList.add('active');
  videoGrid.appendChild(tile);
}

function addTeacherPlaceholder(name) {
  teacherNameEl.textContent = name;
  teacherAvatarEl.textContent = name.charAt(0).toUpperCase();
  teacherTile.dataset.peerId = 'teacher-placeholder';
}

// ─────────────────────────────────────────────────────────────────────────────
//  PARTICIPANTS PANEL
// ─────────────────────────────────────────────────────────────────────────────
function refreshParticipantsList() {
  const items = [];
  // Self
  items.push(`
    <div class="part-item">
      <div class="part-avatar">${myName.charAt(0).toUpperCase()}</div>
      <div class="part-info">
        <div class="part-name">${myName} (you)</div>
        <div class="part-role">${myRole}</div>
      </div>
    </div>`);

  PM.all().forEach(p => {
    const kickBtn = myRole === 'teacher' && p.role === 'student'
      ? `<button class="part-kick-btn" data-id="${p.socketId || ''}" title="Remove">🚫</button>
         <button class="part-mute-btn" data-id="${p.socketId || ''}" title="Mute">🔇</button>`
      : '';
    items.push(`
      <div class="part-item">
        <div class="part-avatar">${p.name.charAt(0).toUpperCase()}</div>
        <div class="part-info">
          <div class="part-name">${p.name}</div>
          <div class="part-role">${p.role}</div>
        </div>
        <div class="part-actions">${kickBtn}</div>
      </div>`);
  });

  participantsList.innerHTML = items.join('');

  // Kick/mute buttons
  participantsList.querySelectorAll('.part-kick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('kick-participant', { targetId: btn.dataset.id });
    });
  });
  participantsList.querySelectorAll('.part-mute-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      socket.emit('mute-participant', { targetId: btn.dataset.id });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  SESSION START
// ─────────────────────────────────────────────────────────────────────────────
async function startSession(role) {
  myName = (nameInput.value.trim() || `User ${Math.floor(Math.random() * 9000) + 1000}`);
  roomId = (roomInput.value.trim() || genRoomId());
  myRole = role;

  lobbyStatus.textContent = 'Getting camera…';

  localStream = await getLocalMedia();

  lobbyStatus.textContent = 'Connecting to server…';

  // Sync with URL
  window.location.hash = roomId;

  // Production Backend URL
  const DEFAULT_PORT = '3001';
  const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? (window.location.port === DEFAULT_PORT ? '' : `http://localhost:${DEFAULT_PORT}`)
    : 'https://nexora-ylt5.onrender.com';

  socket = io(BACKEND_URL, {
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000
  });

  socket.on('connect', () => {
    myId = socket.id;
    socket.emit('join-room', { roomId, role: myRole, name: myName });
  });

  socket.on('connect_error', (e) => {
    lobbyStatus.textContent = `Cannot connect: ${e.message}`;
  });

  socket.on('reconnect', () => {
    showToast('Reconnected to server');
    setStatus('Reconnected', 'active');
    socket.emit('join-room', { roomId, role: myRole, name: myName });
  });

  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') {
      setStatus('Connection lost — reconnecting…', 'waiting');
    }
  });

  // ── ROOM EVENTS ────────────────────────────────────────────────────────────
  socket.on('room-joined', async ({ role: confirmedRole, selfId, participants, chatHistory, canvasStrokes, participantCount }) => {
    myId = selfId;
    myRole = confirmedRole;

    switchToCall();
    initTimer();
    setupRoleUI();

    chRoomId.textContent = roomId;
    setStatus('Connected', 'active');

    // Restore chat history
    if (chatHistory?.length) {
      chatHistory.forEach(m => renderChatMessage(m, false));
    }

    // Restore canvas strokes
    if (canvasStrokes?.length) {
      canvasStrokes.forEach(s => receiveCanvasStroke(s));
    }

    // Mount local video
    if (myRole === 'teacher') {
      // Teacher: show own video in large teacher slot immediately
      attachLocalToTeacherSlot();
    } else {
      // Student: add self to student grid
      addSelfStudentTile();
      // If teacher is already in the room, show their placeholder immediately
      const teacherInRoom = participants.find(p => p.role === 'teacher');
      if (teacherInRoom) {
        addTeacherPlaceholder(teacherInRoom.name);
      }
    }

    // Connect to all existing participants (initiate offers to everyone)
    for (const p of participants) {
      await PM.create(p.socketId, p.role, p.name);

      // Create student tile if not teacher
      if (p.role !== 'teacher' && !document.getElementById(`tile-${p.socketId}`)) {
        createStudentTile(p.socketId, p.name);
      }

      // Initiate connection
      await PM.offer(p.socketId);
    }

    updateConnectionStatus();
  });

  socket.on('room-full', () => { lobbyStatus.textContent = 'Room is full (max 12).'; });
  socket.on('room-locked', () => { lobbyStatus.textContent = 'Room is locked by teacher.'; });

  socket.on('user-joined', async ({ socketId, role, name, participantCount }) => {
    showToast(`${name} joined`);

    // Create placeholder tile immediately
    if (role === 'teacher') {
      addTeacherPlaceholder(name);
    } else {
      if (!document.getElementById(`tile-${socketId}`)) {
        createStudentTile(socketId, name);
      }
    }

    // Create peer connection but DO NOT send offer (wait for new user to send offer)
    if (!PM.has(socketId)) {
      await PM.create(socketId, role, name);
    }

    chParticipants.textContent = `${participantCount} in session`;
    partBadge.textContent = participantCount;
    rpPartBadge.textContent = participantCount;
    refreshParticipantsList();
  });

  socket.on('user-left', ({ socketId, name, participantCount }) => {
    showToast(`${name || 'Someone'} left`);
    PM.close(socketId);
    chParticipants.textContent = `${participantCount} in session`;
    partBadge.textContent = participantCount;
    rpPartBadge.textContent = participantCount;
    refreshParticipantsList();
  });

  socket.on('promoted-to-teacher', () => {
    myRole = 'teacher';
    setupRoleUI();
    showToast('You are now the host!');
    attachLocalToTeacherSlot();
    // Remove self from student grid
    const self = $('tile-self'); if (self) self.remove();
  });

  socket.on('teacher-changed', ({ newTeacherId, name }) => {
    showToast(`${name} is now the host`);
  });

  socket.on('kicked', () => {
    showToast('You were removed from the session');
    setTimeout(leaveCall, 1500);
  });

  socket.on('force-mute', () => {
    if (!micOn) return;
    micOn = false;
    applyMicState();
    showToast('You were muted by the host');
  });

  socket.on('room-lock-changed', ({ locked }) => {
    isLocked = locked;
    if (lockRoomBtn) {
      lockRoomBtn.title = locked ? 'Unlock room' : 'Lock room';
      lockRoomBtn.style.color = locked ? 'var(--red)' : '';
    }
    showToast(locked ? '🔒 Room locked' : '🔓 Room unlocked');
  });

  // ── WEBRTC SIGNALING ───────────────────────────────────────────────────────
  socket.on('offer', async ({ from, fromName, fromRole, offer }) => {
    const name = fromName || PM.get(from)?.name || `User-${from.slice(0, 4)}`;
    const role = fromRole || PM.get(from)?.role || 'student';
    await PM.handleOffer(from, offer, role, name);
  });

  socket.on('answer', async ({ from, fromName, fromRole, answer }) => {
    // Update stored metadata if we have it
    const peer = PM.get(from);
    if (peer && fromName) { peer.name = fromName; peer.role = fromRole || peer.role; }
    await PM.handleAnswer(from, answer);
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    await PM.addIce(from, candidate);
  });

  socket.on('peer-screen-share-started', ({ from }) => {
    if (from === teacherTile.dataset.peerId) showToast('Teacher is sharing their screen');
  });

  socket.on('peer-screen-share-stopped', ({ from }) => {
    if (from === teacherTile.dataset.peerId) showToast('Screen share ended');
  });

  // ── CHAT ──────────────────────────────────────────────────────────────────
  socket.on('chat-message', (msg) => {
    renderChatMessage(msg, true);
  });

  // ── CANVAS ────────────────────────────────────────────────────────────────
  socket.on('canvas-stroke', (stroke) => {
    receiveCanvasStroke(stroke);
    // Students: auto-open the canvas panel so they see it
    if (myRole === 'student' && !canvasOpen) {
      openCanvasPanel();
      showToast('📋 Whiteboard opened by teacher');
    }
  });
  socket.on('canvas-clear', clearCanvasLocal);
  socket.on('canvas-undo', undoCanvasLocal);

  // ── QUIZ ──────────────────────────────────────────────────────────────────
  socket.on('quiz-created', ({ total }) => {
    showTeacherQuizState('ready');
    $('tqReadyCount').textContent = `${total} questions`;
    showToast(`Quiz saved (${total} questions)`);
  });

  socket.on('quiz-question', ({ question, options, index, total }) => {
    quiz.currentIndex = index; quiz.total = total; quiz.answered = false; quiz.running = true;
    if (myRole === 'teacher') {
      showTeacherQuizState('running');
      tqCounter.textContent = `Q ${index + 1}/${total}`;
      tqProgressFill.style.width = `${((index + 1) / total) * 100}%`;
      tqCurrentQ.textContent = question;
      tqCurrentOpts.innerHTML = options.map((o, i) => `
        <div class="tq-opt-display">
          <span class="opt-lbl ${['A', 'B', 'C', 'D'][i]}">${['A', 'B', 'C', 'D'][i]}</span>${o}
        </div>`).join('');
    } else {
      $('sqWaiting').style.display = 'none';
      sqQuestion.style.display = 'block';
      sqCounter.textContent = `Q ${index + 1}/${total}`;
      sqProgressFill.style.width = `${((index + 1) / total) * 100}%`;
      sqQText.textContent = question;
      sqResult.style.display = 'none'; sqResult.className = 'sq-result';
      sqOpts.innerHTML = options.map((o, i) => `
        <button class="sq-opt-btn" data-i="${i}">
          <span class="opt-lbl ${['A', 'B', 'C', 'D'][i]}">${['A', 'B', 'C', 'D'][i]}</span>${o}
        </button>`).join('');
      sqOpts.querySelectorAll('.sq-opt-btn').forEach(btn => {
        btn.addEventListener('click', () => submitAnswer(+btn.dataset.i));
      });
    }
    // Open quiz panel
    openPanel('quiz');
  });

  socket.on('answer-result', ({ correct, correct_index, points }) => {
    quiz.answered = true;
    sqOpts.querySelectorAll('.sq-opt-btn').forEach((btn, i) => {
      btn.disabled = true;
      if (i === correct_index) btn.classList.add('correct');
    });
    sqResult.style.display = 'block';
    sqResult.className = `sq-result ${correct ? 'correct' : 'wrong'}`;
    sqResult.textContent = correct ? `✓ Correct! +${points} pts` : `✗ Wrong. Correct: ${['A', 'B', 'C', 'D'][correct_index]}`;
  });

  socket.on('update-leaderboard', ({ leaderboard }) => renderLeaderboard(leaderboard));

  socket.on('quiz-ended', ({ leaderboard }) => {
    renderLeaderboard(leaderboard);
    if (myRole === 'teacher') showTeacherQuizState('ended');
    else { sqQuestion.style.display = 'none'; sqWaiting.style.display = 'block'; sqWaiting.innerHTML = '<div class="sq-icon">🏆</div><p class="rp-hint text-center">Quiz over! Check the leaderboard.</p>'; }
    showToast('Quiz ended!');
  });

  socket.on('quiz-reset', () => {
    if (myRole === 'teacher') showTeacherQuizState('idle');
    else { sqQuestion.style.display = 'none'; sqWaiting.style.display = 'block'; sqWaiting.innerHTML = '<div class="sq-icon">⏳</div><p class="rp-hint text-center">Waiting for quiz…</p>'; }
    lbRows.innerHTML = '<p class="rp-hint text-center">No scores yet</p>';
    showToast('Quiz reset');
  });

  socket.on('ai-response', ({ text, error }) => {
    removeAILoading();
    renderAIMessage(text, 'bot', error);
  });

  socket.on('ai-status-changed', ({ enabled }) => {
    if (myRole === 'student') {
      const aiInput = document.getElementById('aiInput');
      const aiSend = document.getElementById('aiSend');
      if (aiInput) aiInput.disabled = !enabled;
      if (aiSend) aiSend.disabled = !enabled;
      if (!enabled) {
        showToast('AI Assistant has been disabled by the teacher');
        aiInput.placeholder = 'AI Disabled';
      } else {
        showToast('AI Assistant is now available');
        aiInput.placeholder = 'Ask AI...';
      }
    }
  });
}

function setupRoleUI() {
  myRoleBadge.textContent = myRole === 'teacher' ? '⬡ Teacher' : '◈ Student';
  myRoleBadge.className = `role-badge${myRole === 'student' ? ' student' : ''}`;

  if (myRole === 'teacher') {
    ctrlScreen.style.display = 'flex';
    ctrlCanvas.style.display = 'flex';
    teacherRoomCtrls.style.display = 'flex';
    teacherQuizPanel.style.display = 'block';
    studentQuizPanel.style.display = 'none';
    videoGrid.classList.add('teacher-view');
  } else {
    ctrlScreen.style.display = 'none';
    ctrlCanvas.style.display = 'none';
    teacherRoomCtrls.style.display = 'none';
    teacherQuizPanel.style.display = 'none';
    studentQuizPanel.style.display = 'block';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CHAT
// ─────────────────────────────────────────────────────────────────────────────
function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  chatInput.value = '';
  socket.emit('chat-message', { text });
  // Also broadcast via data channels (P2P fallback is automatic via server relay)
}

function receiveDataChannelChat(msg) {
  renderChatMessage(msg, true);
}

function renderChatMessage(msg, isNew) {
  const isEmpty = chatMessages.querySelector('.chat-empty');
  if (isEmpty) isEmpty.remove();

  const isMine = msg.senderId === myId;
  const d = document.createElement('div');
  d.className = `chat-msg ${isMine ? 'own' : 'other'}`;
  const t = new Date(msg.ts);
  const time = `${t.getHours().toString().padStart(2, '0')}:${t.getMinutes().toString().padStart(2, '0')}`;
  d.innerHTML = `
    <div class="chat-msg-meta">
      <span class="chat-msg-name">${isMine ? 'You' : msg.senderName}</span>
      <span class="chat-msg-role ${msg.role}">${msg.role}</span>
      <span>${time}</span>
    </div>
    <div class="chat-bubble">${escapeHtml(msg.text)}</div>`;
  chatMessages.appendChild(d);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  if (isNew && !chatPanelOpen) {
    unreadChat++;
    chatBadge.textContent = unreadChat;
    chatBadge.style.display = 'flex';
    rpChatBadge.textContent = unreadChat;
    rpChatBadge.style.display = 'inline';
  }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  MEDIA CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function applyMicState() {
  if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = micOn; });
  ctrlMic.classList.toggle('off', !micOn);
  ctrlMic.querySelector('span').textContent = micOn ? 'Mic' : 'Unmute';
  // Update all peer connections with new track state
  PM.updateLocalTracks();
}

function applyCamState() {
  if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = camOn; });
  ctrlCam.classList.toggle('off', !camOn);
  ctrlCam.querySelector('span').textContent = camOn ? 'Camera' : 'Start Cam';
  if (myRole === 'teacher') {
    teacherMutedEl.style.display = camOn ? 'none' : '';
  }
  // Update all peer connections with new track state
  PM.updateLocalTracks();
}

async function toggleScreen() {
  if (!screenOn) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      screenOn = true;
      ctrlScreen.classList.add('screen-on');
      ctrlScreen.querySelector('span').textContent = 'Stop';

      const vt = screenStream.getVideoTracks()[0];

      // Replace video track in all peer connections
      PM.replaceVideoTrack(vt);

      // Show screen locally
      if (myRole === 'teacher') {
        const newStream = new MediaStream([vt, ...(localStream?.getAudioTracks() || [])]);
        teacherVideoEl.srcObject = newStream;
        teacherVideoEl.classList.add('active');
        teacherPlaceholder.classList.add('hidden');
      }

      socket.emit('screen-share-started');
      showToast('Screen sharing started');

      vt.onended = () => toggleScreen();
    } catch {
      showToast('Screen share cancelled');
    }
  } else {
    screenOn = false;
    ctrlScreen.classList.remove('screen-on');
    ctrlScreen.querySelector('span').textContent = 'Share';

    if (screenStream) {
      screenStream.getTracks().forEach(t => t.stop());
      screenStream = null;
    }

    if (localStream) {
      const vt = localStream.getVideoTracks()[0];
      if (vt) PM.replaceVideoTrack(vt);

      if (myRole === 'teacher') {
        teacherVideoEl.srcObject = localStream;
      }
    }

    socket?.emit('screen-share-stopped');
    showToast('Screen sharing stopped');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  CANVAS WHITEBOARD
// ─────────────────────────────────────────────────────────────────────────────
let ctx2 = null;   // initialized lazily when canvas panel opens
let canvasTool = 'pen';
let drawing = false;
let lastX = 0, lastY = 0;
let strokeId = 0;
const strokeHistory = [];   // for undo

function resizeCanvas() {
  if (!ctx2) ctx2 = mainCanvas.getContext('2d');
  const rect = canvasOverlay.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const toolbar = canvasOverlay.querySelector('.canvas-toolbar');
  const toolH = toolbar ? toolbar.offsetHeight : 50;
  const w = rect.width;
  const h = Math.max(rect.height - toolH, 100);
  mainCanvas.width = w * dpr;
  mainCanvas.height = h * dpr;
  mainCanvas.style.width = w + 'px';
  mainCanvas.style.height = h + 'px';
  ctx2.scale(dpr, dpr);
  replayStrokes();
}

function replayStrokes() {
  if (!ctx2) return;
  ctx2.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
  strokeHistory.forEach(s => drawStroke(s));
}

function drawStroke(s) {
  if (!ctx2) return;
  ctx2.save();
  if (s.tool === 'eraser') {
    ctx2.globalCompositeOperation = 'destination-out';
    ctx2.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    ctx2.globalCompositeOperation = 'source-over';
    ctx2.strokeStyle = s.color;
  }
  ctx2.lineWidth = s.size;
  ctx2.lineCap = 'round'; ctx2.lineJoin = 'round';
  if (s.tool === 'pen' || s.tool === 'eraser') {
    ctx2.beginPath(); ctx2.moveTo(s.x0, s.y0); ctx2.lineTo(s.x1, s.y1); ctx2.stroke();
  } else if (s.tool === 'rect') {
    ctx2.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
  } else if (s.tool === 'circle') {
    ctx2.beginPath();
    const rx = Math.abs(s.x1 - s.x0) / 2, ry = Math.abs(s.y1 - s.y0) / 2;
    ctx2.ellipse(s.x0 + rx * (s.x1 > s.x0 ? 1 : -1), s.y0 + ry * (s.y1 > s.y0 ? 1 : -1), rx, ry, 0, 0, Math.PI * 2);
    ctx2.stroke();
  }
  ctx2.restore();
}

function getCanvasPos(e) {
  const r = mainCanvas.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return { x: src.clientX - r.left, y: src.clientY - r.top };
}

function canvasPointerDown(e) {
  if (myRole !== 'teacher') return;
  e.preventDefault();
  drawing = true; strokeId++;
  const { x, y } = getCanvasPos(e);
  lastX = x; lastY = y;
}

function canvasPointerMove(e) {
  if (!drawing || myRole !== 'teacher') return;
  e.preventDefault();
  const { x, y } = getCanvasPos(e);
  if (canvasTool === 'pen' || canvasTool === 'eraser') {
    const stroke = { tool: canvasTool, color: canvasColor.value, size: +canvasSize.value, x0: lastX, y0: lastY, x1: x, y1: y, strokeId };
    drawStroke(stroke);
    strokeHistory.push(stroke);
    emitStroke(stroke);
    lastX = x; lastY = y;
  }
}

function canvasPointerUp(e) {
  if (!drawing || myRole !== 'teacher') return;
  drawing = false;
  const { x, y } = getCanvasPos(e);
  if (canvasTool === 'rect' || canvasTool === 'circle') {
    const stroke = { tool: canvasTool, color: canvasColor.value, size: +canvasSize.value, x0: lastX, y0: lastY, x1: x, y1: y, strokeId };
    drawStroke(stroke);
    strokeHistory.push(stroke);
    emitStroke(stroke);
  }
}

function emitStroke(stroke) {
  socket?.emit('canvas-stroke', stroke);
  PM.broadcastData({ type: 'canvas', stroke });
}

function receiveCanvasStroke(s) {
  if (!s) return;
  strokeHistory.push(s);
  drawStroke(s);
}

function clearCanvasLocal() {
  strokeHistory.length = 0;
  if (!ctx2) return;
  ctx2.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
}

function undoCanvasLocal() {
  if (!strokeHistory.length) return;
  const lastId = strokeHistory[strokeHistory.length - 1]?.strokeId;
  while (strokeHistory.length && strokeHistory[strokeHistory.length - 1]?.strokeId === lastId) {
    strokeHistory.pop();
  }
  replayStrokes();
}

function openCanvasPanel() {
  canvasOpen = true;
  canvasOverlay.style.display = 'flex';
  // Lazy-init canvas context
  if (!ctx2) ctx2 = mainCanvas.getContext('2d');

  // Students see canvas but can't draw — hide toolbar
  const toolbar = canvasOverlay.querySelector('.canvas-toolbar');
  if (toolbar) toolbar.style.display = myRole === 'teacher' ? 'flex' : 'none';

  // Student canvas: show a close button only
  if (myRole === 'student') {
    let sClose = document.getElementById('studentCanvasClose');
    if (!sClose) {
      sClose = document.createElement('button');
      sClose.id = 'studentCanvasClose';
      sClose.textContent = '✕ Close Board';
      sClose.style.cssText = 'position:absolute;top:10px;right:14px;z-index:5;background:rgba(30,33,64,0.9);color:rgba(255,255,255,0.7);border:1px solid rgba(255,255,255,0.15);border-radius:7px;padding:6px 12px;cursor:pointer;font-size:12px;font-family:inherit;';
      sClose.addEventListener('click', closeCanvasPanel);
      canvasOverlay.appendChild(sClose);
    }
    sClose.style.display = 'block';
  }

  if (ctrlCanvas) {
    ctrlCanvas.classList.add('canvas-on');
    ctrlCanvas.querySelector('span').textContent = 'Close Board';
  }
  setTimeout(resizeCanvas, 50);
}

function closeCanvasPanel() {
  canvasOpen = false;
  canvasOverlay.style.display = 'none';
  if (ctrlCanvas) {
    ctrlCanvas.classList.remove('canvas-on');
    ctrlCanvas.querySelector('span').textContent = 'Board';
  }
  const sClose = document.getElementById('studentCanvasClose');
  if (sClose) sClose.style.display = 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
//  PANEL NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
function openPanel(name) {
  rightPanel.classList.add('open');
  chatPanelOpen = name === 'chat';
  if (name === 'chat') {
    unreadChat = 0;
    chatBadge.style.display = 'none';
    rpChatBadge.style.display = 'none';
  }

  // Activate correct rp-tab and rp-body
  document.querySelectorAll('.rp-tab').forEach(t => t.classList.toggle('active', t.dataset.panel === name));
  document.querySelectorAll('.rp-body').forEach(b => b.classList.toggle('active', b.id === `panel${name.charAt(0).toUpperCase() + name.slice(1)}`));

  // Sidebar nav active state
  document.querySelectorAll('.sn-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
}

function closeRightPanel() {
  rightPanel.classList.remove('open');
  chatPanelOpen = false;
  document.querySelectorAll('.sn-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.sn-btn[data-panel="video"]').forEach(b => b.classList.add('active'));
}

// ─────────────────────────────────────────────────────────────────────────────
//  QUIZ UI HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function showTeacherQuizState(s) {
  tqIdle.style.display = s === 'idle' ? 'block' : 'none';
  tqBuilder.style.display = s === 'builder' ? 'block' : 'none';
  tqReady.style.display = s === 'ready' ? 'block' : 'none';
  tqRunning.style.display = s === 'running' ? 'block' : 'none';
  tqEnded.style.display = s === 'ended' ? 'block' : 'none';
}

function addQuestionCard() {
  const idx = qBuilderList.children.length;
  const card = document.createElement('div');
  card.className = 'q-card';
  card.innerHTML = `
    <div class="q-card-num">QUESTION ${idx + 1}</div>
    <textarea placeholder="Enter question…" class="qc-text" rows="2"></textarea>
    <div class="q-opts-grid">
      ${['A', 'B', 'C', 'D'].map((l, i) => `
        <div class="q-opt-row">
          <span class="q-opt-lbl ${l}">${l}</span>
          <input type="text" class="qc-opt" data-opt="${i}" placeholder="Option ${l}"/>
        </div>`).join('')}
    </div>
    <div class="q-correct-row">
      Correct: <select class="qc-correct">
        ${['A', 'B', 'C', 'D'].map((l, i) => `<option value="${i}">${l}</option>`).join('')}
      </select>
    </div>
    <button class="q-remove-btn">Remove</button>`;
  card.querySelector('.q-remove-btn').addEventListener('click', () => {
    card.remove();
    // Re-number
    qBuilderList.querySelectorAll('.q-card-num').forEach((el, i) => el.textContent = `QUESTION ${i + 1}`);
  });
  qBuilderList.appendChild(card);
}

function collectQuiz() {
  const cards = qBuilderList.querySelectorAll('.q-card');
  if (!cards.length) { showToast('Add at least one question'); return null; }
  const questions = [];
  for (const c of cards) {
    const text = c.querySelector('.qc-text').value.trim();
    if (!text) { showToast('Fill in all question texts'); return null; }
    const opts = [...c.querySelectorAll('.qc-opt')].map(i => i.value.trim());
    if (opts.some(o => !o)) { showToast('Fill in all options'); return null; }
    const correct = +c.querySelector('.qc-correct').value;
    questions.push({ text, options: opts, correct });
  }
  return questions;
}

function submitAnswer(idx) {
  if (quiz.answered) return;
  quiz.answered = true;
  socket.emit('submit-answer', { roomId, answerIndex: idx });
  sqOpts.querySelectorAll('.sq-opt-btn').forEach((b, i) => {
    b.disabled = true;
    if (i === idx) b.classList.add('selected');
  });
}

function renderLeaderboard(board) {
  if (!board?.length) { lbRows.innerHTML = '<p class="rp-hint text-center">No scores yet</p>'; return; }
  lbRows.innerHTML = board.map((e, i) => `
    <div class="lb-row">
      <span class="lb-rank">${['🥇', '🥈', '🥉'][i] || `#${i + 1}`}</span>
      <span class="lb-name">${e.name}</span>
      <span class="lb-score">${e.score} pts</span>
    </div>`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI ASSISTANT FRONTEND
// ─────────────────────────────────────────────────────────────────────────────
function sendAIChat() {
  const text = aiInput.value.trim();
  if (!text || !socket) return;
  aiInput.value = '';
  renderAIMessage(text, 'user');
  showAILoading();
  socket.emit('ai-chat', { prompt: text });
}

function renderAIMessage(text, sender, isError) {
  const d = document.createElement('div');
  d.className = `ai-msg ${sender}`;
  
  if (sender === 'bot' && !isError) {
    d.innerHTML = `
      <div class="ai-bubble">
        ${escapeHtml(text)}
        <button class="ai-replay-btn" title="Replay Voice">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
        </button>
      </div>`;
    
    // Add replay listener
    const btn = d.querySelector('.ai-replay-btn');
    btn.addEventListener('click', () => speakText(text));
  } else {
    d.innerHTML = `<div class="ai-bubble ${isError ? 'error' : ''}">${escapeHtml(text)}</div>`;
  }
  
  aiMessages.appendChild(d);
  aiMessages.scrollTop = aiMessages.scrollHeight;

  if (sender === 'bot' && !isError && aiTtsEnabled) {
    speakText(text);
  }
}

async function speakText(text) {
  try {
    const DEFAULT_PORT = '3001';
    const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? (window.location.port === DEFAULT_PORT ? '' : `http://localhost:${DEFAULT_PORT}`)
      : 'https://nexora-ylt5.onrender.com';

    const res = await fetch(`${BACKEND_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error('TTS Fetch Failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.play();
  } catch (err) {
    console.error('[TTS]', err.message);
  }
}

function showAILoading() {
  const d = document.createElement('div');
  d.className = 'ai-msg bot ai-loading';
  d.id = 'aiLoading';
  d.innerHTML = `<div class="ai-loading-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>`;
  aiMessages.appendChild(d);
  aiMessages.scrollTop = aiMessages.scrollHeight;
}

function removeAILoading() {
  const l = $('aiLoading');
  if (l) l.remove();
}

// ─────────────────────────────────────────────────────────────────────────────
//  LEAVE
// ─────────────────────────────────────────────────────────────────────────────
function leaveCall() {
  console.log('[Leave] Exiting classroom...');
  leaveModal.classList.remove('active');
  
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); }
  PM.closeAll();
  clearInterval(timerInt);
  socket?.disconnect(); socket = null;
  localStream = null; screenStream = null;
  micOn = true; camOn = true; screenOn = false; unreadChat = 0;
  canvasOpen = false; ctx2 = null; strokeHistory.length = 0;

  // Reset UI
  callScreen.classList.remove('active');
  lobbyScreen.classList.add('active');
  lobbyStatus.textContent = '';
  videoGrid.querySelectorAll('.student-tile, #tile-self').forEach(t => t.remove());
  teacherVideoEl.srcObject = null;
  teacherVideoEl.classList.remove('active');
  teacherPlaceholder.classList.remove('hidden');
  teacherNameEl.textContent = 'Teacher';
  teacherAvatarEl.textContent = 'T';
  delete teacherTile.dataset.peerId;
  chatMessages.innerHTML = '<div class="chat-empty">No messages yet.<br/>Say hello! 👋</div>';
  if (myRole === 'teacher') showTeacherQuizState('idle');
  lbRows.innerHTML = '<p class="rp-hint text-center">No scores yet</p>';
  rightPanel.classList.remove('open');
  canvasOverlay.style.display = 'none';
  chTimer.textContent = '00:00';
  chParticipants.textContent = '1 in session';
  partBadge.textContent = '1';
  rpPartBadge.textContent = '1';
}

// ─────────────────────────────────────────────────────────────────────────────
//  THEME TOGGLE
// ─────────────────────────────────────────────────────────────────────────────
function initTheme() {
  const savedTheme = localStorage.getItem('nexora-theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('nexora-theme', next);
  showToast(`Theme: ${next.toUpperCase()}`);
}

initTheme();

// ─────────────────────────────────────────────────────────────────────────────
//  KEYBOARD HAPTICS (Animation)
// ─────────────────────────────────────────────────────────────────────────────

function handleTyping(e) {
  const input = e.target;
  input.classList.remove('typing');
  void input.offsetWidth; // Force reflow
  input.classList.add('typing');
}

// ─────────────────────────────────────────────────────────────────────────────
//  EVENT LISTENERS
// ─────────────────────────────────────────────────────────────────────────────
nameInput?.addEventListener('input', handleTyping);
roomInput?.addEventListener('input', handleTyping);

// Theme
$('lobbyThemeToggle')?.addEventListener('click', toggleTheme);
$('callThemeToggle')?.addEventListener('click', toggleTheme);

// Lobby
diceBtn.addEventListener('click', () => { roomInput.value = genRoomId(); });
document.querySelectorAll('.media-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.media-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); mediaMode = btn.dataset.mode;
  });
});
createBtn.addEventListener('click', () => startSession('teacher'));
joinBtn.addEventListener('click', () => startSession('student'));
roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') roomInput.focus(); });

// Call
copyRoomBtn.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(roomId); showToast('Room ID copied!'); }
  catch { showToast('Copy failed'); }
});
leaveBtn.addEventListener('click', () => leaveModal.classList.add('active'));
ctrlLeave.addEventListener('click', () => leaveModal.classList.add('active'));
confirmLeaveBtn.addEventListener('click', leaveCall);
cancelLeaveBtn.addEventListener('click', () => leaveModal.classList.remove('active'));

ctrlMic.addEventListener('click', () => { micOn = !micOn; applyMicState(); showToast(micOn ? '🔊 Mic on' : '🔇 Muted'); });
ctrlCam.addEventListener('click', () => { camOn = !camOn; applyCamState(); showToast(camOn ? '📷 Camera on' : '📷 Camera off'); });
ctrlScreen.addEventListener('click', toggleScreen);
ctrlCanvas.addEventListener('click', () => { canvasOpen ? closeCanvasPanel() : openCanvasPanel(); });

lockRoomBtn?.addEventListener('click', () => socket?.emit('lock-room'));
muteAllBtn?.addEventListener('click', () => { socket?.emit('mute-all'); showToast('All students muted'); });

// Sidebar nav
document.querySelectorAll('.sn-btn[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    const p = btn.dataset.panel;
    if (p === 'video') closeRightPanel();
    else openPanel(p);
  });
});

// Mobile ctrl bar nav buttons
document.querySelectorAll('.mobile-nav-btn[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => openPanel(btn.dataset.panel));
});

// Right panel tabs
document.querySelectorAll('.rp-tab[data-panel]').forEach(tab => {
  tab.addEventListener('click', () => openPanel(tab.dataset.panel));
});

// Chat
chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); } });
chatInput.addEventListener('focus', () => { unreadChat = 0; chatBadge.style.display = 'none'; rpChatBadge.style.display = 'none'; });

// AI Assistant
let aiTtsEnabled = false;
aiSend.addEventListener('click', sendAIChat);
aiInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAIChat(); } });

if (typeof aiTtsToggle !== 'undefined' && aiTtsToggle) {
  aiTtsToggle.addEventListener('click', () => {
    aiTtsEnabled = !aiTtsEnabled;
    aiTtsToggle.style.opacity = aiTtsEnabled ? '1' : '0.6';
    aiTtsToggle.style.color = aiTtsEnabled ? 'var(--blue)' : '';
    if (aiTtsEnabled) aiTtsToggle.classList.add('ai-tts-rainbow');
    else aiTtsToggle.classList.remove('ai-tts-rainbow');
    if (!aiTtsEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
    showToast(aiTtsEnabled ? 'AI Voice Enabled' : 'AI Voice Disabled');
  });
}

// Canvas toolbar
document.querySelectorAll('.ct-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ct-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); canvasTool = btn.dataset.tool;
  });
});
canvasUndo.addEventListener('click', () => { undoCanvasLocal(); socket?.emit('canvas-undo'); });
canvasClear.addEventListener('click', () => { clearCanvasLocal(); socket?.emit('canvas-clear'); PM.broadcastData({ type: 'canvas-clear' }); });
canvasSave.addEventListener('click', () => {
  const link = document.createElement('a');
  link.download = 'nexora-board.png';
  link.href = mainCanvas.toDataURL();
  link.click();
});
closeCanvas.addEventListener('click', closeCanvasPanel);

// Canvas draw events
mainCanvas.addEventListener('mousedown', canvasPointerDown);
mainCanvas.addEventListener('mousemove', canvasPointerMove);
mainCanvas.addEventListener('mouseup', canvasPointerUp);
mainCanvas.addEventListener('mouseleave', canvasPointerUp);
mainCanvas.addEventListener('touchstart', canvasPointerDown, { passive: false });
mainCanvas.addEventListener('touchmove', canvasPointerMove, { passive: false });
mainCanvas.addEventListener('touchend', canvasPointerUp);

window.addEventListener('resize', () => { if (canvasOpen) resizeCanvas(); });

// Quiz builder events
openBuilderBtn.addEventListener('click', () => {
  qBuilderList.innerHTML = '';
  addQuestionCard(); addQuestionCard(); addQuestionCard();
  showTeacherQuizState('builder');
});
addQBtn.addEventListener('click', addQuestionCard);
cancelBuilderBtn.addEventListener('click', () => showTeacherQuizState('idle'));
saveQuizBtn.addEventListener('click', () => {
  const q = collectQuiz(); if (!q) return;
  socket.emit('create-quiz', { roomId, questions: q });
});
editQuizBtn.addEventListener('click', () => {
  qBuilderList.innerHTML = ''; addQuestionCard(); addQuestionCard(); addQuestionCard();
  showTeacherQuizState('builder');
});
startQuizBtn.addEventListener('click', () => socket.emit('start-quiz', { roomId }));
nextQBtn.addEventListener('click', () => socket.emit('next-question', { roomId }));
endQuizBtn.addEventListener('click', () => socket.emit('end-quiz', { roomId }));
resetQuizBtn.addEventListener('click', () => socket.emit('reset-quiz', { roomId }));

aiToggle?.addEventListener('change', () => {
  socket?.emit('toggle-ai', { enabled: aiToggle.checked });
});

document.getElementById('closeRightPanelBtn')?.addEventListener('click', closeRightPanel);

// Sync with URL on load
window.addEventListener('load', () => {
  const hash = window.location.hash.slice(1);
  if (hash && roomInput) {
    roomInput.value = hash;
  }
});

// Cleanup
window.addEventListener('beforeunload', () => {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  socket?.disconnect();
  PM.closeAll();
});