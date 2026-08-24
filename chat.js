/* ============================================================================
   Singh Foundation — chat.js
   Frontend controller: wires index.html's DOM to /api/chat and EmailJS lead capture.
   DOM IDs used here must match index.html's documented hook comment block exactly.
   ============================================================================ */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     1. CONFIG — client-specific values live here, top of file
     --------------------------------------------------------------------- */

  // EmailJS — shared master template across all Auren.ai clients. Reuse as-is.
  const EMAILJS_SERVICE_ID  = 'service_xmzpo7h';
  const EMAILJS_TEMPLATE_ID = 'template_imy3ypj';
  const EMAILJS_PUBLIC_KEY  = 'J09sX-M5eqwPj4Qik'; // fill from Auren.ai EmailJS account

  // This client's details — set once per build
  const CLIENT_CONFIG = {
    to_email: 'Saraluthra13@gmail.com',
    business_name: 'Singh Foundation',
    bot_name: 'Sara'
  };

  const API_ENDPOINT = '/api/chat';
  const TIMEOUT_MS = 25000; // must match api/chat.js's TIMEOUT_MS

  /* ---------------------------------------------------------------------
     2. DOM REFERENCES
     --------------------------------------------------------------------- */
  const chatMessages   = document.getElementById('chat-messages');
  const chatInput      = document.getElementById('chat-input');
  const sendBtn        = document.getElementById('send-btn');
  const typingIndicator = document.getElementById('typing-indicator');
  const quickReplies   = document.getElementById('quick-replies');
  const sidebar        = document.getElementById('sidebar');
  const sidebarToggle  = document.getElementById('sidebar-toggle');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  const langSelectRow = document.getElementById('lang-select');

  /* ---------------------------------------------------------------------
     3. STATE
     --------------------------------------------------------------------- */
  let conversationHistory = []; // [{role: 'user'|'model', text: '...'}]
  let isWaitingForResponse = false;
  let hasFiredLeadEmail = false;
  let lastBotAskedForName = false;

  const leadInfo = {
    name: null,
    phone: null,
    email: null,
    lastUserMessage: ''
  };

  /* ---------------------------------------------------------------------
     4. EMAILJS INIT (guarded — never let a missing SDK crash the page)
     --------------------------------------------------------------------- */
  try {
    if (window.emailjs && typeof window.emailjs.init === 'function') {
      window.emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
    }
  } catch (err) {
    console.warn('EmailJS init skipped:', err);
  }

  /* ---------------------------------------------------------------------
     5. UTILITIES
     --------------------------------------------------------------------- */
  function nowLabel() {
    return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Renders **bold** markdown-style segments from the model's reply as <strong>
  function renderRichText(str) {
    const escaped = escapeHtml(str);
    return escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function appendMessage(role, text) {
    const row = document.createElement('div');
    row.className = 'msg-row ' + (role === 'user' ? 'user' : 'bot');

    const avatar = document.createElement('div');
    avatar.className = 'msg-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.innerHTML = role === 'user'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'
      : '<span class="mascot-photo"></span>';

    const wrap = document.createElement('div');
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.innerHTML = renderRichText(text);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = nowLabel();

    wrap.appendChild(bubble);
    wrap.appendChild(time);
    row.appendChild(avatar);
    row.appendChild(wrap);
    chatMessages.appendChild(row);
    scrollToBottom();
  }

  function showTyping() {
    typingIndicator.hidden = false;
    scrollToBottom();
  }
  function hideTyping() {
    typingIndicator.hidden = true;
  }

  function appendConfirmationCard() {
    const card = document.createElement('div');
    card.className = 'confirmation-card';
    card.innerHTML =
      '<div class="check-icon">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' +
      '</div>' +
      '<div class="confirmation-card-text">' +
        '<strong>You\'re all set!</strong>' +
        '<span>Singh Foundation has your details — the team will reach out shortly.</span>' +
      '</div>';
    chatMessages.appendChild(card);
    scrollToBottom();
  }

  // Strips the model's invisible [[CONFIRMED]] token from the displayed text.
  // Returns { cleanText, wasConfirmed } so the caller can show the card once.
  const CONFIRMATION_TOKEN_RE = /\s*\[\[CONFIRMED\]\]\s*$/i;
  function extractConfirmation(rawText) {
    const wasConfirmed = CONFIRMATION_TOKEN_RE.test(rawText);
    const cleanText = rawText.replace(CONFIRMATION_TOKEN_RE, '').trim();
    return { cleanText: cleanText || rawText, wasConfirmed };
  }

  function setSending(state) {
    isWaitingForResponse = state;
    sendBtn.disabled = state;
    chatInput.disabled = state;
  }

  function autoGrowInput() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 110) + 'px';
  }

  /* ---------------------------------------------------------------------
     6. LEAD DETECTION
     Mirrors backend LEAD CAPTURE ORDER: name before phone, never both at once.
     --------------------------------------------------------------------- */
  const PHONE_RE = /(\+?\d[\d\s-]{8,14}\d)/;
  const EMAIL_RE = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/;

  function tryExtractContact(userText) {
    const phoneMatch = userText.match(PHONE_RE);
    if (phoneMatch && !leadInfo.phone) leadInfo.phone = phoneMatch[1].trim();

    const emailMatch = userText.match(EMAIL_RE);
    if (emailMatch && !leadInfo.email) leadInfo.email = emailMatch[1].trim();

    // Fallback name capture: if the bot's last message asked for a name,
    // and this reply is short + plausible, treat it as the name even
    // without a strict "my name is X" phrase.
    if (!leadInfo.name && lastBotAskedForName) {
      const trimmed = userText.trim();
      const wordCount = trimmed.split(/\s+/).length;
      const looksLikeName = /^[a-zA-Z\s.]{2,40}$/.test(trimmed) && wordCount <= 4;
      if (looksLikeName) leadInfo.name = trimmed;
    }

    // Explicit phrasing fallback: "my name is X" / "naam X hai"
    const nameMatch = userText.match(/(?:my name is|i am|i'm|naam)\s+([a-zA-Z\s.]{2,40})/i);
    if (nameMatch && !leadInfo.name) leadInfo.name = nameMatch[1].trim();

    leadInfo.lastUserMessage = userText;
  }

  function botMessageAskedForName(botText) {
    return /\b(name|naam)\b/i.test(botText);
  }

  function maybeFireLeadEmail() {
    if (hasFiredLeadEmail) return;
    if (!leadInfo.name) return; // name is the minimum bar before we notify
    if (!window.emailjs || typeof window.emailjs.send !== 'function') {
      console.warn('EmailJS SDK not loaded — lead email was not sent. Check that the EmailJS <script> tag is present in index.html.');
      return;
    }

    hasFiredLeadEmail = true; // guard against double-fire in one session

    const params = {
      to_email: CLIENT_CONFIG.to_email,
      visitor_name: leadInfo.name,
      business_name: CLIENT_CONFIG.business_name,
      visitor_email: leadInfo.email || 'Not provided',
      visitor_phone: leadInfo.phone || 'Not provided',
      visitor_message: leadInfo.lastUserMessage || 'No additional details provided',
      captured_at: new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }),
      source: CLIENT_CONFIG.bot_name + ' - ' + CLIENT_CONFIG.business_name
    };

    window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, params)
      .then(function () {
        console.info('Lead email sent.');
      })
      .catch(function (err) {
        // Never block the conversation on a failed lead email — log only.
        console.warn('Lead email failed to send:', err);
      });
  }

  /* ---------------------------------------------------------------------
     7. SEND FLOW
     --------------------------------------------------------------------- */
  async function sendMessage(rawText, options) {
    options = options || {};
    const text = (rawText || '').trim();
    if (!text || isWaitingForResponse) return;

    if (!quickReplies.hidden) quickReplies.hidden = true;
    if (langSelectRow && !langSelectRow.hidden) langSelectRow.hidden = true;

    if (!options.hideUserBubble) {
      appendMessage('user', text);
      tryExtractContact(text);
    }
    conversationHistory.push({ role: 'user', text: text });

    chatInput.value = '';
    autoGrowInput();
    setSending(true);
    showTyping();

    const controller = new AbortController();
    const timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    try {
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: conversationHistory }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error('Non-200 response: ' + res.status);
      }

      const data = await res.json();
      const rawReply = (data && data.reply) ? data.reply : "Sorry, I didn't quite catch that — could you rephrase?";
      const { cleanText: replyText, wasConfirmed } = extractConfirmation(rawReply);

      hideTyping();
      appendMessage('bot', replyText);
      if (wasConfirmed) appendConfirmationCard();
      conversationHistory.push({ role: 'model', text: replyText });

      lastBotAskedForName = botMessageAskedForName(replyText);
      maybeFireLeadEmail(); // safe to call every turn — internally guarded against double-fire

    } catch (err) {
      clearTimeout(timeoutId);
      hideTyping();
      console.error('Chat request failed:', err);

      const friendly = (err && err.name === 'AbortError')
        ? "Taking a bit longer than usual — please try again in a moment."
        : "Sorry, I'm having trouble connecting right now. Please try again, or reach us directly on WhatsApp.";
      appendMessage('bot', friendly);
    } finally {
      setSending(false);
      chatInput.focus();
    }
  }

  /* ---------------------------------------------------------------------
     8. EVENT WIRING
     --------------------------------------------------------------------- */
  sendBtn.addEventListener('click', function () {
    sendMessage(chatInput.value);
  });

  chatInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(chatInput.value);
    }
  });

  chatInput.addEventListener('input', autoGrowInput);

  quickReplies.addEventListener('click', function (e) {
    const btn = e.target.closest('.quick-reply-btn');
    if (!btn) return;
    const msg = btn.getAttribute('data-message');
    if (msg) sendMessage(msg);
  });

  if (langSelectRow) {
    langSelectRow.addEventListener('click', function (e) {
      const btn = e.target.closest('.lang-pill-btn');
      if (!btn) return;
      const lang = btn.getAttribute('data-lang');
      const instruction = lang === 'hindi'
        ? 'Please continue this entire conversation in Hindi (Devanagari script) from now on.'
        : 'Please continue this entire conversation in Punjabi (Gurmukhi script) from now on.';
      sendMessage(instruction, { hideUserBubble: true });
    });
  }

  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', function () {
      const isOpen = sidebar.classList.toggle('open');
      sidebarBackdrop.classList.toggle('open', isOpen);
      sidebarToggle.setAttribute('aria-expanded', String(isOpen));
    });
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', function () {
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('open');
      sidebarToggle.setAttribute('aria-expanded', 'false');
    });
  }

  // Initial focus for desktop/full-tab use (skip on touch to avoid keyboard pop-up on load)
  if (!('ontouchstart' in window)) {
    chatInput.focus();
  }

})();
