(() => {
  const WS_URL = window.CHAT_CONFIG.WS_URL;

  // ---------- Elementos de la página ----------
  const $ = (id) => document.getElementById(id);
  const loginBox = $('login');
  const loginForm = $('login-form');
  const nameInput = $('name-input');
  const loginError = $('login-error');
  const chatBox = $('chat');
  const myName = $('my-name');
  const statusEl = $('status');
  const messagesEl = $('messages');
  const typingEl = $('typing');
  const userListEl = $('user-list');
  const userCountEl = $('user-count');
  const messageForm = $('message-form');
  const messageInput = $('message-input');
  const sendBtn = $('send-btn');

  // ---------- Estado ----------
  let ws = null;
  let username = null;
  let joined = false;           // el servidor ya confirmó el nombre
  let retries = 0;              // intentos de reconexión seguidos
  let reconnectTimer = null;
  let intentionalClose = false; // true = no reconectar
  let lastTypingSent = 0;
  const typingUsers = new Map(); // nombre -> temporizador

  // ---------- Estado de la conexión, leído de readyState ----------
  // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  const STATES = [
    { text: 'Conectando…', cls: 'status-connecting' },
    { text: 'Conectado', cls: 'status-open' },
    { text: 'Cerrando…', cls: 'status-closing' },
    { text: 'Desconectado', cls: 'status-closed' },
  ];

  function renderStatus() {
    const state = ws ? ws.readyState : 3;
    let { text, cls } = STATES[state];
    if (state === 3 && reconnectTimer) text = 'Reconectando…';
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;

    // Solo se puede escribir si hay conexión abierta y el nombre fue aceptado
    const canSend = state === 1 && joined;
    messageInput.disabled = !canSend;
    sendBtn.disabled = !canSend;
  }
  // readyState no avisa cuando cambia, así que lo miramos varias veces por segundo
  setInterval(renderStatus, 300);

  // ---------- Conexión ----------
  function connect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    ws = new WebSocket(WS_URL);
    renderStatus();

    ws.addEventListener('open', () => {
      retries = 0;
      ws.send(JSON.stringify({ type: 'join', name: username }));
      renderStatus();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg);
    });

    ws.addEventListener('close', () => {
      joined = false;
      renderStatus();
      if (!intentionalClose) scheduleReconnect();
    });
  }

  // Espera creciente (1 s, 2 s, 4 s, 8 s… hasta 30 s), con un poco de azar
  function scheduleReconnect() {
    const base = Math.min(30000, 1000 * 2 ** retries);
    const delay = base / 2 + Math.random() * (base / 2);
    retries += 1;
    if (!chatBox.classList.contains('hidden')) {
      addSystem(`Conexión perdida. Reintentando en ${Math.round(delay / 1000)} s…`);
    } else {
      loginError.textContent = 'No se pudo conectar. Reintentando…';
    }
    reconnectTimer = setTimeout(connect, delay);
    renderStatus();
  }

  // ---------- Lo que dice el servidor ----------
  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'joined':
        joined = true;
        username = msg.name;
        loginBox.classList.add('hidden');
        chatBox.classList.remove('hidden');
        myName.textContent = username;
        messagesEl.textContent = ''; // limpia, para no duplicar al reconectar
        msg.history.forEach(addMessage);
        if (msg.history.length) addSystem('— mensajes anteriores —');
        renderUsers(msg.users);
        messageInput.focus();
        renderStatus();
        break;
      case 'message':
        clearTyping(msg.name);
        addMessage(msg);
        break;
      case 'system':
        addSystem(msg.text);
        break;
      case 'users':
        renderUsers(msg.users);
        break;
      case 'typing':
        showTyping(msg.name);
        break;
      case 'error':
        if (!joined && chatBox.classList.contains('hidden')) {
          // falló al entrar (nombre vacío o repetido): no reconectar
          loginError.textContent = msg.text;
          intentionalClose = true;
          ws.close(1000);
        } else if (!joined) {
          // falló el re-ingreso tras una reconexión: se cierra y se reintenta
          addSystem(msg.text);
          ws.close();
        } else {
          addSystem(msg.text);
        }
        break;
    }
  }

  // ---------- Pintar en pantalla (siempre con textContent: sin XSS) ----------
  function scrollDown() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function formatTime(ts) {
    return new Date(ts).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  }

  function addMessage({ name, text, ts }) {
    const box = document.createElement('div');
    box.className = 'msg' + (name === username ? ' mine' : '');

    const author = document.createElement('div');
    author.className = 'author';
    author.textContent = name;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(ts);
    author.appendChild(time);

    const body = document.createElement('div');
    body.textContent = text; // <b>hola</b> se ve literal, no en negrita

    box.append(author, body);
    messagesEl.appendChild(box);
    scrollDown();
  }

  function addSystem(text) {
    const el = document.createElement('div');
    el.className = 'system';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollDown();
  }

  function renderUsers(users) {
    userListEl.textContent = '';
    users.forEach((u) => {
      const li = document.createElement('li');
      li.textContent = u;
      userListEl.appendChild(li);
    });
    userCountEl.textContent = users.length;
  }

  // ---------- "Está escribiendo…" ----------
  function renderTyping() {
    const names = [...typingUsers.keys()];
    if (names.length === 0) typingEl.textContent = '';
    else if (names.length === 1) typingEl.textContent = `${names[0]} está escribiendo…`;
    else typingEl.textContent = `${names.join(', ')} están escribiendo…`;
  }

  function showTyping(name) {
    clearTimeout(typingUsers.get(name));
    // desaparece solo a los 3 segundos si no llega más
    typingUsers.set(name, setTimeout(() => clearTyping(name), 3000));
    renderTyping();
  }

  function clearTyping(name) {
    clearTimeout(typingUsers.get(name));
    typingUsers.delete(name);
    renderTyping();
  }

  // ---------- Formularios ----------
  loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    if (!name) {
      loginError.textContent = 'Escribe un nombre.';
      return;
    }
    loginError.textContent = '';
    username = name;
    intentionalClose = false;
    retries = 0;
    if (ws && ws.readyState <= 1) {
      intentionalClose = true;
      ws.close(1000);
      intentionalClose = false;
    }
    connect();
  });

  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return; // no se envían mensajes vacíos
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'message', text }));
    messageInput.value = '';
  });

  messageInput.addEventListener('input', () => {
    const now = Date.now();
    // avisamos como máximo cada 2 segundos
    if (now - lastTypingSent > 2000 && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'typing' }));
      lastTypingSent = now;
    }
  });

  // Al cerrar o salir de la página, nos despedimos con el código 1000 (cierre normal)
  window.addEventListener('pagehide', () => {
    intentionalClose = true;
    if (ws && ws.readyState <= 1) ws.close(1000, 'El usuario salió');
  });

  renderStatus();
})();