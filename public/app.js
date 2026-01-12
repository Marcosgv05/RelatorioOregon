/**
 * Oregon Analytics - Frontend App
 * Sistema de Analytics de Atendimento WhatsApp
 */

// Estado global
const state = {
  user: null,
  token: null,
  instances: [],
  selectedInstance: null,
  contacts: [],
  selectedContact: null,
  socket: null,
  chart: null,
  chartDays: 30
};

// Helpers DOM
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ==================== API ====================
const api = {
  baseUrl: '/api',

  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = { 'Content-Type': 'application/json', ...options.headers };

    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    try {
      const res = await fetch(url, { ...options, headers, credentials: 'include' });

      let data;
      const contentType = res.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await res.json();
      } else {
        const text = await res.text();
        throw new Error(`Erro ${res.status}: ${text || res.statusText}`);
      }

      if (!res.ok) {
        throw new Error(data.error || data.message || `Erro ${res.status}: ${res.statusText}`);
      }

      return data;
    } catch (err) {
      console.error('API Error:', endpoint, err);
      if (err instanceof Error) {
        throw err;
      }
      throw new Error('Erro de conexão com o servidor');
    }
  },

  // Auth
  login: (email, password) => api.request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  register: (name, email, password, company) => api.request('/auth/register', { method: 'POST', body: JSON.stringify({ name, email, password, company }) }),
  logout: () => api.request('/auth/logout', { method: 'POST' }),
  getMe: () => api.request('/auth/me'),

  // Instances
  getInstances: () => api.request('/instances'),
  createInstance: (name) => api.request('/instances', { method: 'POST', body: JSON.stringify({ name }) }),
  connectInstance: (id) => api.request(`/instances/${id}/connect`, { method: 'POST' }),
  disconnectInstance: (id) => api.request(`/instances/${id}/disconnect`, { method: 'POST' }),
  deleteInstance: (id) => api.request(`/instances/${id}`, { method: 'DELETE' }),
  generateConnectLink: (id) => api.request(`/connect/${id}/connect-link`, { method: 'POST' }),

  // Analytics
  getDashboard: (instanceId, startDate, endDate) => {
    let url = `/analytics/dashboard/${instanceId}`;
    const params = [];
    if (startDate) params.push(`startDate=${startDate}`);
    if (endDate) params.push(`endDate=${endDate}`);
    if (params.length) url += `?${params.join('&')}`;
    return api.request(url);
  },
  getContacts: (instanceId, limit = 50) => api.request(`/analytics/contacts/${instanceId}?limit=${limit}`),
  getConversation: (contactId) => api.request(`/analytics/conversation/${contactId}`),
  getPending: (instanceId) => api.request(`/analytics/pending/${instanceId}`),
  sendMessage: (contactId, message) => api.request(`/analytics/send/${contactId}`, { method: 'POST', body: JSON.stringify({ message }) })
};

// ==================== Socket.IO ====================
function initSocket() {
  state.socket = io();

  state.socket.on('connect', () => {
    console.log('🔌 Socket conectado');
    if (state.selectedInstance) {
      state.socket.emit('subscribe', { userId: state.user?.id, instanceId: state.selectedInstance });
    }
  });

  state.socket.on('qr-code', (data) => {
    console.log('QR Code recebido:', data);
    if (data.qr) {
      showQRCode(data.qr);
    } else if (data.qrCode) {
      // Compatibilidade com formato do Arauto
      showQRCode(data.qrCode);
    }
  });

  state.socket.on('connected', (data) => {
    showToast(`WhatsApp conectado: ${data.phone}`, 'success');
    closeModal('qrModal');
    loadInstances(); // Usa debounce automático
  });

  state.socket.on('disconnected', () => {
    showToast('WhatsApp desconectado', 'error');
    loadInstances(); // Usa debounce automático
  });

  state.socket.on('new-message', (data) => {
    console.log('[Socket] Nova mensagem recebida:', data);

    // Atualiza fila de mensagens
    if (state.selectedInstance) {
      loadPendingQueue(state.selectedInstance);
    }

    // Atualiza conversas se estiver na view
    if ($('#conversationsView').classList.contains('active')) {
      loadContacts(state.selectedInstance);
    }

    if (state.selectedContact && data.contact?.id === state.selectedContact) {
      loadConversation(state.selectedContact);
    }
  });

  state.socket.on('new-lead', (data) => {
    showToast(`Novo lead: ${data.contactName || data.phone}`, 'info');
  });

  state.socket.on('qr-loop', (data) => {
    showToast(data.message, 'error');
    closeModal('qrModal');
  });
}

// ==================== Views ====================
function showView(viewId) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${viewId}View`).classList.add('active');

  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $(`.nav-item[data-view="${viewId}"]`)?.classList.add('active');

  const titles = { dashboard: 'Dashboard', conversations: 'Conversas', instances: 'Conexões' };
  $('#pageTitle').textContent = titles[viewId] || 'Dashboard';

  if (viewId === 'dashboard' && state.selectedInstance) {
    loadDashboard();
  } else if (viewId === 'conversations' && state.selectedInstance) {
    loadContacts(state.selectedInstance);
  } else if (viewId === 'instances') {
    loadInstances();
  }
}

// ==================== Dashboard ====================
async function loadDashboard() {
  if (!state.selectedInstance) {
    return;
  }

  const startDate = $('#startDate').value;
  const endDate = $('#endDate').value;

  try {
    const { metrics } = await api.getDashboard(state.selectedInstance, startDate, endDate);

    // KPI Cards
    $('#metricFirstResponse').textContent = metrics.responseTimes.firstResponseTimeFormatted || '0s';
    $('#metricAvgResponse').textContent = metrics.responseTimes.avgResponseTimeFormatted || '0s';
    $('#metricPending').textContent = metrics.pendingContacts || 0;

    // KPI de Follows Receptivos
    $('#metricReturning').textContent = metrics.totals?.returningContacts || 0;
    $('#metricNewLeads').textContent = metrics.totals?.newContacts || 0;

    // Atualiza gráfico
    updateChart(metrics.contactsByDay || []);

    // Carrega fila de mensagens pendentes (com identificação de follows)
    loadPendingQueue(state.selectedInstance);

  } catch (err) {
    console.error('Erro ao carregar dashboard:', err);
  }
}

async function loadPendingQueue(instanceId) {
  try {
    const { contacts } = await api.getContacts(instanceId, 20);

    // Filtra contatos que receberam mensagem mas não respondemos
    const pending = contacts.filter(c => !c.lastMessageFromMe && c.lastMessage);

    $('#queueCount').textContent = `${pending.length} aguardando`;

    const tbody = $('#queueBody');

    if (!pending.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4">
            <div class="queue-empty">
              <p>Nenhuma mensagem aguardando resposta</p>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = pending.slice(0, 10).map(c => {
      const initials = (c.name || c.phone).substring(0, 2).toUpperCase();
      const isFollow = c.isReturning || c.returnCount > 0;
      const avatarClass = isFollow ? 'contact-avatar-sm returning-avatar' : 'contact-avatar-sm';

      // Define o status: Follow > Novo > Aguardando
      let statusClass, statusText;
      if (isFollow) {
        statusClass = 'returning';
        statusText = 'Follow';
      } else if (isNew(c.lastMessageAt)) {
        statusClass = 'new';
        statusText = 'Novo';
      } else {
        statusClass = 'waiting';
        statusText = 'Aguardando';
      }

      return `
      <tr>
        <td>
          <div class="contact-cell">
            <div class="${avatarClass}">${initials}</div>
            <div>
              <div class="contact-name">${escapeHtml(c.name || 'Sem nome')}${isFollow ? ' <span class="follow-tag">FOLLOW</span>' : ''}</div>
              <div class="contact-phone">${c.phone}</div>
            </div>
          </div>
        </td>
        <td><span class="message-snippet">${escapeHtml(c.lastMessage || '')}</span></td>
        <td><span class="time-cell">${formatTimeAgo(c.lastMessageAt)}</span></td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
      </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Erro ao carregar fila:', err);
  }
}

function isNew(dateStr) {
  if (!dateStr) return false;
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000 / 60;
  return diff < 30; // Menos de 30 minutos
}


function updateChart(data) {
  const ctx = $('#contactsChart').getContext('2d');

  if (state.chart) {
    state.chart.destroy();
  }

  // Preenche dias faltantes
  const days = state.chartDays;
  const today = new Date();
  const labels = [];
  const receivedData = [];
  const sentData = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    labels.push(d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }));

    const dayData = data.find(item => item.date === dateStr);
    receivedData.push(dayData?.received || 0);
    sentData.push(dayData?.sent || 0);
  }

  state.chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Recebidas',
          data: receivedData,
          backgroundColor: 'rgba(16, 185, 129, 0.8)',
          borderColor: 'rgba(16, 185, 129, 1)',
          borderWidth: 0,
          borderRadius: 4,
          barThickness: 16
        },
        {
          label: 'Enviadas',
          data: sentData,
          backgroundColor: 'rgba(16, 185, 129, 0.3)',
          borderColor: 'rgba(16, 185, 129, 0.5)',
          borderWidth: 0,
          borderRadius: 4,
          barThickness: 16
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: '#a1a1aa',
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 20,
            font: { size: 12, family: 'Inter' }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#71717a', font: { size: 11 } }
        },
        y: {
          grid: { color: '#27272a' },
          ticks: { color: '#71717a', font: { size: 11 } },
          beginAtZero: true
        }
      }
    }
  });
}

// ==================== Conversations ====================
async function loadContacts(instanceId) {
  try {
    console.log('[Conversas] Carregando contatos para instância:', instanceId);
    const { contacts } = await api.getContacts(instanceId);
    console.log('[Conversas] Contatos recebidos:', contacts?.length || 0, contacts);
    state.contacts = contacts;

    const list = $('#contactsList');

    if (!contacts.length) {
      list.innerHTML = '<div class="contact-empty">Nenhum contato ainda</div>';
      return;
    }

    list.innerHTML = contacts.map(c => {
      const initials = (c.name || c.phone).substring(0, 2).toUpperCase();
      return `
      <div class="contact-item" data-id="${c.id}">
        <div class="contact-avatar-list">${initials}</div>
        <div class="contact-info">
          <div class="contact-row">
            <span class="contact-name-list">${escapeHtml(c.name || c.phone)}</span>
            <span class="contact-time">${formatTimeAgo(c.lastMessageAt)}</span>
          </div>
          <div class="contact-preview">${escapeHtml(c.lastMessage || '')}</div>
        </div>
      </div>
      `;
    }).join('');

    list.querySelectorAll('.contact-item').forEach(item => {
      item.addEventListener('click', () => selectContact(parseInt(item.dataset.id)));
    });

  } catch (err) {
    console.error('Erro ao carregar contatos:', err);
  }
}

async function selectContact(contactId) {
  state.selectedContact = contactId;

  $$('.contact-item').forEach(c => c.classList.remove('active'));
  $(`.contact-item[data-id="${contactId}"]`)?.classList.add('active');

  const contact = state.contacts.find(c => c.id === contactId);
  if (contact) {
    $('#chatContactName').textContent = contact.name || contact.phone;
    $('#chatContactPhone').textContent = contact.phone;
    const initials = (contact.name || contact.phone).substring(0, 2).toUpperCase();
    $('#chatAvatar').textContent = initials;
  }

  await loadConversation(contactId);
}

async function loadConversation(contactId) {
  try {
    const { messages } = await api.getConversation(contactId);

    const container = $('#chatMessages');
    const inputContainer = $('#chatInputContainer');

    // Mostra o campo de input quando um contato está selecionado
    if (inputContainer) {
      inputContainer.style.display = 'block';
    }

    if (!messages.length) {
      container.innerHTML = `
        <div class="chat-empty">
          <p>Nenhuma mensagem ainda</p>
        </div>
      `;
      return;
    }

    container.innerHTML = messages.map(m => `
      <div class="message-bubble ${m.fromMe ? 'sent' : 'received'}">
        ${escapeHtml(m.body)}
        <div class="message-time">${formatMessageTime(m.timestamp)}</div>
      </div>
    `).join('');

    container.scrollTop = container.scrollHeight;

  } catch (err) {
    console.error('Erro ao carregar conversa:', err);
  }
}

/**
 * Envia uma mensagem para o contato selecionado
 */
async function sendMessage(message) {
  if (!state.selectedContact || !message.trim()) {
    return;
  }

  const inputContainer = $('#chatInputContainer');
  const messageInput = $('#messageInput');
  const sendBtn = $('#sendMessageBtn');

  try {
    // Desabilita o input enquanto envia
    inputContainer.classList.add('sending');
    sendBtn.disabled = true;
    messageInput.disabled = true;

    // Adiciona a mensagem na interface imediatamente (otimista)
    const container = $('#chatMessages');
    const tempId = `temp_${Date.now()}`;
    const tempMessage = document.createElement('div');
    tempMessage.id = tempId;
    tempMessage.className = 'message-bubble sent';
    tempMessage.innerHTML = `
      ${escapeHtml(message)}
      <div class="message-time">Enviando...</div>
    `;
    container.appendChild(tempMessage);
    container.scrollTop = container.scrollHeight;

    // Envia via API
    const response = await api.sendMessage(state.selectedContact, message);

    // Atualiza a mensagem com o horário correto
    const sentMessage = document.getElementById(tempId);
    if (sentMessage) {
      sentMessage.innerHTML = `
        ${escapeHtml(message)}
        <div class="message-time">${formatMessageTime(response.timestamp)}</div>
      `;
    }

    // Limpa o input
    messageInput.value = '';

    // Atualiza a lista de contatos
    loadContacts(state.selectedInstance);

  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);
    showToast(err.message || 'Erro ao enviar mensagem', 'error');

    // Remove a mensagem temporária em caso de erro
    const tempMessage = document.getElementById(`temp_${Date.now()}`);
    if (tempMessage) tempMessage.remove();
  } finally {
    inputContainer.classList.remove('sending');
    sendBtn.disabled = false;
    messageInput.disabled = false;
    messageInput.focus();
  }
}

// ==================== Instances ====================
// Debounce para evitar múltiplas chamadas simultâneas
let loadInstancesTimer = null;
async function loadInstances(immediate = false) {
  // Se não for imediato, aguarda 300ms para evitar chamadas em cascata
  if (!immediate && loadInstancesTimer) {
    clearTimeout(loadInstancesTimer);
  }

  const doLoad = async () => {
    try {
      const { instances } = await api.getInstances();
      state.instances = instances;

      // Selector
      const select = $('#instanceSelect');
      select.innerHTML = '<option value="">Selecione uma conexão</option>' +
        instances.map(i => `<option value="${i.id}">${i.name} ${i.phone ? `(${i.phone})` : ''}</option>`).join('');

      if (state.selectedInstance) {
        select.value = state.selectedInstance;
      }

      // Grid
      const grid = $('#instancesGrid');

      if (!instances.length) {
        grid.innerHTML = `
          <div class="instance-card" style="text-align: center; padding: 64px 32px;">
            <h3 style="margin-bottom: 8px; font-size: 16px; font-weight: 600;">Nenhuma conexão</h3>
            <p style="color: var(--text-secondary); font-size: 14px;">Crie sua primeira conexão WhatsApp</p>
          </div>
        `;
        return;
      }

      grid.innerHTML = instances.map(i => `
        <div class="instance-card">
          <div class="instance-header">
            <span class="instance-name">${escapeHtml(i.name)}</span>
            <span class="instance-status ${i.status}">${getStatusText(i.status)}</span>
          </div>
          <div class="instance-phone">${i.phone || 'Não conectado'}</div>
          <div class="instance-actions">
            ${i.status === 'connected'
          ? `<button class="btn btn-secondary" onclick="disconnectInstance('${i.id}')">Desconectar</button>`
          : `<button class="btn btn-primary" onclick="connectInstance('${i.id}')">Conectar</button>`
        }
            <button class="btn btn-secondary btn-sm" onclick="generateConnectLink('${i.id}')" title="Gerar Link">
              🔗
            </button>
            <button class="btn btn-secondary btn-sm" onclick="deleteInstance('${i.id}')" title="Remover">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M6 2V4M10 2V4M3 4H13M12 4V13C12 14.1046 11.1046 15 10 15H6C4.89543 15 4 14.1046 4 13V4H12Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M6 7V11M10 7V11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      console.error('Erro ao carregar instâncias:', err);
    }
  };

  if (immediate) {
    await doLoad();
  } else {
    loadInstancesTimer = setTimeout(doLoad, 300);
  }
}

async function createInstance() {
  const name = $('#instanceName').value.trim();
  if (!name) {
    showToast('Digite um nome para a conexão', 'error');
    return;
  }

  try {
    await api.createInstance(name);
    showToast('Conexão criada!', 'success');
    closeModal('newInstanceModal');
    $('#instanceName').value = '';
    loadInstances(true); // Imediato após criar
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function connectInstance(id) {
  try {
    // Garante que o socket está conectado
    if (!state.socket || !state.socket.connected) {
      initSocket();
      // Aguarda o socket conectar
      await new Promise((resolve, reject) => {
        if (state.socket.connected) {
          resolve();
        } else {
          const timeout = setTimeout(() => reject(new Error('Timeout ao conectar socket')), 5000);
          state.socket.once('connect', () => {
            clearTimeout(timeout);
            resolve();
          });
          state.socket.once('connect_error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        }
      });
    }

    // Se inscreve na instância ANTES de iniciar a conexão (importante para receber o QR code)
    state.socket.emit('subscribe', { userId: state.user?.id, instanceId: id });
    state.selectedInstance = id;

    // Mostra o modal primeiro
    showModal('qrModal');

    // Limpa o QR container e mostra loading
    const container = $('#qrContainer');
    if (container) {
      container.innerHTML = `
        <div class="qr-loading">
          <span class="spinner"></span>
          <p>Gerando QR Code...</p>
        </div>
      `;
    }

    // Inicia conexão (isso vai gerar o QR code via Socket.IO)
    const resp = await api.connectInstance(id);

    // Garante que, mesmo se o evento 'qr-code' tiver sido emitido antes, a gente puxa o último QR
    const sessionId = resp?.sessionId;
    if (sessionId) {
      state.socket.emit('request-qr', { sessionId, instanceId: id });
    } else {
      state.socket.emit('request-qr', { instanceId: id });
    }
  } catch (err) {
    console.error('Erro ao conectar:', err);
    closeModal('qrModal');
    showToast(err.message || 'Erro ao conectar', 'error');
  }
}

async function disconnectInstance(id) {
  if (!confirm('Deseja desconectar?')) return;
  try {
    await api.disconnectInstance(id);
    showToast('Desconectado', 'success');
    loadInstances(true); // Imediato após desconectar
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteInstance(id) {
  if (!confirm('Deseja remover esta conexão?')) return;
  try {
    await api.deleteInstance(id);
    showToast('Removido', 'success');
    loadInstances(true); // Imediato após deletar
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showQRCode(qrBase64) {
  const container = $('#qrContainer');
  if (!container) return;

  container.innerHTML = `<img src="${qrBase64}" alt="QR Code" style="max-width: 100%; height: auto; border-radius: 8px;">`;
}

async function generateConnectLink(instanceId) {
  try {
    const { connectLink, instance } = await api.generateConnectLink(instanceId);

    // Copia link para área de transferência
    await navigator.clipboard.writeText(connectLink);

    showToast(`Link copiado! Envie para o cliente conectar: ${instance.name}`, 'success');

    // Mostra modal com instruções
    showConnectLinkModal(connectLink, instance);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function showConnectLinkModal(link, instance) {
  // Criar modal dinamicamente
  const modal = document.createElement('div');
  modal.className = 'modal active';
  modal.id = 'connectLinkModal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width: 550px;">
      <div class="modal-header">
        <h3>🔗 Link de Conexão Gerado</h3>
        <button class="modal-close" onclick="this.closest('.modal').remove()">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6L18 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Instância</label>
          <input type="text" value="${instance.name}" readonly style="background: #2d3748; color: #ffffff; border: 1px solid #4a5568;">
        </div>
        
        <div class="form-group">
          <label>Link de Conexão</label>
          <div style="position: relative;">
            <input type="text" id="connectLinkInput" value="${link}" readonly style="width: 100%; background: #2d3748; color: #ffffff; border: 1px solid #4a5568; font-family: monospace; font-size: 11px; cursor: pointer; padding: 12px; padding-right: 45px;" onclick="this.select()" title="Clique para selecionar">
            <button id="copyLinkBtn" style="position: absolute; right: 4px; top: 50%; transform: translateY(-50%); background: #1a202c; border: 1px solid #4a5568; border-radius: 4px; padding: 6px 8px; cursor: pointer; color: #a0aec0; transition: all 0.2s; display: flex; align-items: center;" onclick="copyConnectLink('${link}')" title="Copiar link">
              <svg id="copyIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
          </div>
        </div>
        
        <div style="background: linear-gradient(135deg, #1a365d 0%, #1a202c 100%); border: 1px solid #2d3748; border-radius: 12px; padding: 20px; margin: 20px 0; color: #e2e8f0;">
          <strong style="color: #10b981; font-size: 14px;">✅ Como usar:</strong>
          <ol style="margin: 12px 0 0 0; padding-left: 20px; line-height: 1.8;">
            <li>Envie este link para o seu cliente</li>
            <li>O cliente acessa o link e escaneia o QR Code</li>
            <li>A conexão aparece automaticamente no seu dashboard</li>
          </ol>
        </div>
        
        <div style="display: flex; gap: 10px; justify-content: center;">
          <button class="btn btn-secondary" onclick="window.open('${link}', '_blank')" style="display: flex; align-items: center; gap: 6px;">
            🔗 Abrir Link
          </button>
          <button class="btn btn-secondary" onclick="this.closest('.modal').remove()">
            Fechar
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);
}

// Função para copiar o link com feedback visual
function copyConnectLink(link) {
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.getElementById('copyLinkBtn');
    const icon = document.getElementById('copyIcon');

    // Ícone de check (sucesso)
    const checkIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    // Ícone de copiar (original)
    const copyIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

    // Feedback visual
    btn.innerHTML = checkIcon;
    btn.style.background = '#10b981';
    btn.style.borderColor = '#10b981';
    btn.style.color = '#ffffff';

    showToast('Link copiado!', 'success');

    // Restaura após 2 segundos
    setTimeout(() => {
      btn.innerHTML = copyIconSvg;
      btn.style.background = '#1a202c';
      btn.style.borderColor = '#4a5568';
      btn.style.color = '#a0aec0';
    }, 2000);
  }).catch(() => {
    showToast('Erro ao copiar link', 'error');
  });
}

// ==================== Auth ====================
async function checkAuth() {
  const token = localStorage.getItem('oregon_token');
  if (!token) {
    showLoginPage();
    return;
  }

  state.token = token;

  try {
    const { user } = await api.getMe();
    state.user = user;
    hideLoginPage();
    initApp();
  } catch (err) {
    localStorage.removeItem('oregon_token');
    showLoginPage();
  }
}

async function login(email, password) {
  try {
    const { user, token } = await api.login(email, password);
    state.user = user;
    state.token = token;
    localStorage.setItem('oregon_token', token);
    hideLoginPage();
    initApp();
  } catch (err) {
    const message = err?.message || 'Erro ao fazer login';
    console.error('Login error:', err);
    showToast(message, 'error');
  }
}

async function register(name, email, password, company) {
  try {
    const { user, token } = await api.register(name, email, password, company);
    state.user = user;
    state.token = token;
    localStorage.setItem('oregon_token', token);
    hideLoginPage();
    initApp();
  } catch (err) {
    const message = err?.message || 'Erro ao cadastrar';
    console.error('Register error:', err);
    showToast(message, 'error');
  }
}

async function logout() {
  try { await api.logout(); } catch (e) { }
  state.user = null;
  state.token = null;
  localStorage.removeItem('oregon_token');
  showLoginPage();
}

function showLoginPage() {
  $('#loginPage').classList.remove('hidden');
}

function hideLoginPage() {
  $('#loginPage').classList.add('hidden');
  updateUserInfo();
}

function updateUserInfo() {
  if (state.user) {
    $('#userName').textContent = state.user.name;
    $('#userEmail').textContent = state.user.email;
    $('#userAvatar').textContent = state.user.name.charAt(0).toUpperCase();
  }
}

// ==================== Utils ====================
function formatTime(seconds) {
  if (!seconds) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}min`;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return new Date(dateStr).toLocaleDateString('pt-BR');
}

function formatMessageTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function getStatusText(status) {
  return { connected: 'Conectado', disconnected: 'Desconectado', connecting: 'Conectando...' }[status] || status;
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showModal(id) { $(`#${id}`).classList.add('active'); }
function closeModal(id) { $(`#${id}`).classList.remove('active'); }

function showToast(message, type = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), 4000);
}

// ==================== Init ====================
async function initApp() {
  initSocket();
  await loadInstances(true); // Carrega imediatamente na inicialização

  // Restaura a instância selecionada do localStorage
  const savedInstance = localStorage.getItem('oregon_selected_instance');
  if (savedInstance && state.instances.some(i => i.id === savedInstance)) {
    state.selectedInstance = savedInstance;
    $('#instanceSelect').value = savedInstance;
    state.socket?.emit('subscribe', { userId: state.user?.id, instanceId: savedInstance });
    loadDashboard();
  }

  // Datas padrão (últimos 30 dias)
  const today = new Date();
  const monthAgo = new Date(today);
  monthAgo.setDate(monthAgo.getDate() - 30);

  $('#endDate').value = today.toISOString().split('T')[0];
  $('#startDate').value = monthAgo.toISOString().split('T')[0];
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  // Navigation
  $$('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      showView(item.dataset.view);
    });
  });

  // Instance selector
  $('#instanceSelect').addEventListener('change', (e) => {
    state.selectedInstance = e.target.value;
    // Persiste a seleção no localStorage
    if (state.selectedInstance) {
      localStorage.setItem('oregon_selected_instance', state.selectedInstance);
      state.socket?.emit('subscribe', { userId: state.user?.id, instanceId: state.selectedInstance });
      loadDashboard();
    } else {
      localStorage.removeItem('oregon_selected_instance');
    }
  });

  // Filter button
  $('#btnFilter').addEventListener('click', loadDashboard);

  // Chart filter buttons
  $$('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.chartDays = parseInt(btn.dataset.days);

      // Atualiza datas
      const today = new Date();
      const start = new Date(today);
      start.setDate(start.getDate() - state.chartDays);
      $('#endDate').value = today.toISOString().split('T')[0];
      $('#startDate').value = start.toISOString().split('T')[0];

      loadDashboard();
    });
  });

  // Login form
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await login($('#loginEmail').value, $('#loginPassword').value);
  });

  // Register form
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await register($('#registerName').value, $('#registerEmail').value, $('#registerPassword').value, $('#registerCompany').value);
  });

  // Login tabs
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.login-form').forEach(f => f.classList.remove('active'));
      btn.classList.add('active');
      $(`#${btn.dataset.tab}Form`).classList.add('active');
    });
  });

  // Logout
  $('#btnLogout').addEventListener('click', logout);

  // New instance
  $('#btnNewInstance').addEventListener('click', () => showModal('newInstanceModal'));
  $('#closeNewInstanceModal').addEventListener('click', () => closeModal('newInstanceModal'));
  $('#newInstanceForm').addEventListener('submit', (e) => { e.preventDefault(); createInstance(); });

  // QR Modal
  $('#closeQrModal').addEventListener('click', () => closeModal('qrModal'));

  // Send message form
  $('#sendMessageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('#messageInput').value;
    if (message.trim()) {
      await sendMessage(message);
    }
  });

  // Contact search
  $('#searchContact').addEventListener('input', (e) => {
    const search = e.target.value.toLowerCase();
    $$('.contact-item').forEach(item => {
      const name = item.querySelector('.contact-name-list')?.textContent.toLowerCase() || '';
      const preview = item.querySelector('.contact-preview')?.textContent.toLowerCase() || '';
      item.style.display = (name.includes(search) || preview.includes(search)) ? '' : 'none';
    });
  });

  // Check auth
  checkAuth();
});

// Global functions
window.connectInstance = connectInstance;
window.disconnectInstance = disconnectInstance;
window.deleteInstance = deleteInstance;
window.generateConnectLink = generateConnectLink;
