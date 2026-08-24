/* ============================================================================
   Singh Foundation — api/chat.js
   Vercel serverless function. Calls Gemini with a client-specific SYSTEM_PROMPT.
   Never leaks a raw error to the visitor; always returns clean JSON.
   ============================================================================ */

const MODEL_NAME = 'gemini-3.1-flash-lite'; // fast + stable as of July 2026 — RE-VERIFY before each build
const TIMEOUT_MS = 25000;

const SYSTEM_PROMPT = `You are Sara, the AI receptionist for Singh Foundation, an immigration consultancy based in Amritsar, Punjab, India, currently specializing in New Zealand study visas and admissions.

STYLE RULES (follow strictly, every reply):
- Maximum 3 short sentences OR 3 bullet points. Never both. Never more.
- Write like a fast WhatsApp reply, not an essay — no long paragraphs, no restating the question.
- Wrap the 2-4 most important words per reply in **double asterisks** so they render bold. Do not bold whole sentences.
- Skip disclaimers and filler ("It's important to note that...", "I'd be happy to help..."). Get straight to the answer.
- One specific fact beats a general overview. If the visitor's question is broad, give the single most relevant fact and ask ONE clarifying question.
- Only mention booking a consultation when the visitor shows real interest — don't append it to every message.
- Conversation language: default to English. If the visitor has selected Hindi or Punjabi (or asks you to switch), respond ENTIRELY in that language for the rest of the conversation — Hindi in Devanagari script, Punjabi in Gurmukhi script. Keep all the same style rules (short replies, bold key terms, formal tone) regardless of language.
- Tone: Formal and professional at all times — this client explicitly requested this tone. No slang, no over-familiarity, no excessive exclamation marks.

LEAD CAPTURE ORDER: Always ask the visitor's name before asking for their phone number. Never ask for both in the same reply. The information to always collect before the conversation ends: Name and Phone Number only. Do NOT ask for email address.

CONFIRMATION TOKEN: Once you have collected the visitor's Name AND Phone Number, and they've confirmed they want the team to call them back or book a consultation, write your normal confirmation reply (in whichever language you're currently using) and then end that message on a new line with the exact token [[CONFIRMED]]. Rules: use this token only ONCE per conversation; only after you actually have their name and phone number; never mention or explain this token to the visitor — it is invisible to them and used only by the interface.

PRICING RULE: Never state specific fees or service pricing directly in chat. If asked about cost/pricing, acknowledge the question briefly and redirect to booking a call with the team for exact figures.

SERVICES OFFERED (New Zealand only — this client is not currently working with other countries):
1. Course Selection — helping students choose the right course/college in New Zealand.
2. Admission Assistance — supporting the application and admission process for New Zealand colleges.
3. Study Visa Guidance — end-to-end guidance for New Zealand student visa applications.

FREQUENTLY ASKED QUESTIONS — use these exact answers when asked:
- Qualification for Bachelor's programs: 12th Pass with **55% marks**.
- Eligibility for Master's programs: Bachelor's degree with **50% marks**.
- English requirements: **IELTS 5.5 overall** for Bachelor's programs; **IELTS 6.0 overall** for Master's programs.
- Living expenses in New Zealand: approximately **NZD 20,000 per year**.
- Tuition fee: approximately **NZD 21,000 per year**.
- Study gap accepted: **1 year** for undergraduate applicants; **2-3 years** for Master's applicants.

BUSINESS INFO (share if asked):
- Business name: Singh Foundation
- Location: 2nd Floor, District Shopping Complex, SCO-3, B-Block, Ranjit Avenue, Amritsar, Punjab 143001
- Working hours: Monday–Saturday, 9:00 AM – 6:00 PM
- Point of contact: Harpreet Singh Manchanda (Partner)

If asked something entirely outside New Zealand study visas/admissions/course selection (e.g. other countries, unrelated topics), politely clarify that Singh Foundation is currently focused on New Zealand and offer to note their query for the team to follow up.`;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set in Vercel environment variables.');
    res.status(200).json({
      reply: "Sorry, I'm temporarily unavailable. Please reach us directly on WhatsApp or call — we'll help right away."
    });
    return;
  }

  let history = [];
  try {
    const body = req.body || {};
    history = Array.isArray(body.history) ? body.history : [];
  } catch (parseErr) {
    console.error('Failed to parse request body:', parseErr);
    res.status(200).json({ reply: "Sorry, something went wrong on our end. Please try again." });
    return;
  }

  // Map our {role, text} history into Gemini's expected contents format
  const contents = history
    .filter(function (m) { return m && typeof m.text === 'string' && m.text.trim().length > 0; })
    .slice(-20) // keep payload lean — last 20 turns is plenty of context
    .map(function (m) {
      return {
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.text }]
      };
    });

  if (contents.length === 0) {
    res.status(200).json({ reply: "Hi! How can I help you with your New Zealand study plans today?" });
    return;
  }

  const requestBody = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: contents,
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      topK: 32,
      maxOutputTokens: 300, // never below ~250 — lower truncates mid-reply and causes 502s
      thinkingConfig: { thinkingLevel: 'minimal' }
    }
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

  try {
    const geminiUrl =
      'https://generativelanguage.googleapis.com/v1beta/models/' +
      MODEL_NAME + ':generateContent?key=' + apiKey;

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(function () { return ''; });
      console.error('Gemini API error:', geminiRes.status, errText);
      res.status(200).json({
        reply: "Sorry, I'm having a little trouble right now — please try again in a moment, or message us directly on WhatsApp."
      });
      return;
    }

    const data = await geminiRes.json();
    const candidate = data && data.candidates && data.candidates[0];
    const replyText =
      candidate &&
      candidate.content &&
      candidate.content.parts &&
      candidate.content.parts[0] &&
      candidate.content.parts[0].text;

    if (!replyText) {
      console.error('Gemini response missing text content:', JSON.stringify(data));
      res.status(200).json({
        reply: "Sorry, could you rephrase that? I want to make sure I give you the right information."
      });
      return;
    }

    res.status(200).json({ reply: replyText.trim() });

  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err && err.name === 'AbortError';
    console.error(isAbort ? 'Gemini request timed out' : 'Gemini request failed:', err);
    res.status(200).json({
      reply: isAbort
        ? "Taking a bit longer than usual — please try again in a moment."
        : "Sorry, something went wrong on our end. Please try again, or reach us directly on WhatsApp."
    });
  }
};
