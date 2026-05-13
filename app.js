// ===== SubForge — Soniox SRT Generator =====
const API_BASE = 'https://api.soniox.com';
let selectedFile = null;
let cachedTokens = null;
let cachedWithTranslation = null; // tracks the translation config used for cached tokens
let abortController = null;
// Translation state
let lastOriginalSubs = null;
let lastTranslatedSubs = null;
let lastOriginalSrt = '';
let lastTranslatedSrt = '';
let currentPreviewTab = 'original';
// Cost tracking
let lastActualUsage = null;

// ===== Soniox Pricing (Async) =====
// https://soniox.com/pricing
const PRICING = {
    inputAudioPerMillion: 1.50,   // $1.50 per 1M audio tokens
    inputTextPerMillion:  3.50,   // $3.50 per 1M text tokens
    outputTextPerMillion: 3.50,   // $3.50 per 1M output tokens
    // Actual API usage rates based on logs:
    // 7,492s audio -> 62,435 audio tokens (~8.33 tokens/sec)
    // 7,492s audio -> 34,845 output text tokens (~4.65 tokens/sec)
    audioTokensPerSecond: 8.333,
    outputTextTokensPerSecond: 4.651,
};

let selectedFileDurationSec = null;

async function getMediaDuration(file) {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const el = document.createElement('video');
        
        const fallback = () => {
            const isVideo = /\.(mp4|webm|mov|avi|mkv|asf)$/i.test(file.name);
            // Use 2500 kbps for typical videos instead of 200 to prevent crazy overestimations
            const estimatedBitrateKbps = isVideo ? 2500 : 128;
            resolve((file.size * 8) / (estimatedBitrateKbps * 1000));
        };

        el.onloadedmetadata = () => {
            URL.revokeObjectURL(url);
            if (el.duration && el.duration !== Infinity && !isNaN(el.duration)) {
                resolve(el.duration);
            } else {
                fallback();
            }
        };
        
        el.onerror = () => {
            URL.revokeObjectURL(url);
            fallback();
        };
        
        el.src = url;
    });
}

function estimateCostFromDuration(durationSec, withTranslation) {
    const audioTokens = durationSec * PRICING.audioTokensPerSecond;
    const outputTokens = durationSec * PRICING.outputTextTokensPerSecond;
    const translationTokens = withTranslation ? outputTokens * 1.5 : 0; // translation adds output

    const audioCost = (audioTokens / 1_000_000) * PRICING.inputAudioPerMillion;
    const outputCost = ((outputTokens + translationTokens) / 1_000_000) * PRICING.outputTextPerMillion;
    const totalCost = audioCost + outputCost;

    return {
        estimatedDurationSec: durationSec,
        audioTokens,
        outputTokens,
        translationTokens,
        audioCost,
        outputCost,
        totalCost,
    };
}

function calcActualCost(usage) {
    if (!usage) return null;
    
    // If API provided exact costs, use them
    if (usage.api_provided_cost && usage.api_provided_cost.totalCost > 0) {
        return {
            audioTokens: usage.input_audio_tokens || 0,
            inputTextTokens: usage.input_text_tokens || 0,
            outputTextTokens: usage.output_text_tokens || 0,
            audioCost: usage.api_provided_cost.audioCost,
            inputTextCost: usage.api_provided_cost.inputTextCost,
            outputTextCost: usage.api_provided_cost.outputTextCost,
            totalCost: usage.api_provided_cost.totalCost,
        };
    }

    // Fallback manual calculation
    const audioCost = ((usage.input_audio_tokens || 0) / 1_000_000) * PRICING.inputAudioPerMillion;
    const inputTextCost = ((usage.input_text_tokens || 0) / 1_000_000) * PRICING.inputTextPerMillion;
    const outputTextCost = ((usage.output_text_tokens || 0) / 1_000_000) * PRICING.outputTextPerMillion;
    return {
        audioTokens: usage.input_audio_tokens || 0,
        inputTextTokens: usage.input_text_tokens || 0,
        outputTextTokens: usage.output_text_tokens || 0,
        audioCost,
        inputTextCost,
        outputTextCost,
        totalCost: audioCost + inputTextCost + outputTextCost,
    };
}

function formatCost(usd) {
    if (usd === 0) return '$0.0000';
    if (usd < 0.01) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(3)}`;
}

function formatDuration(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m === 0) return `${s}초`;
    return `${m}분 ${s}초`;
}

// ===== Utilities =====
const $ = (s) => document.querySelector(s);
const showToast = (msg, type = 'info') => {
    const c = $('#toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4000);
};
const formatSize = (b) => b < 1024 ? b + ' B' : b < 1048576 ? (b/1024).toFixed(1) + ' KB' : (b/1048576).toFixed(1) + ' MB';
const msToSrt = (ms) => {
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const mi = ms % 1000;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(mi).padStart(3,'0')}`;
};

// ===== API Helper =====
async function apiFetch(endpoint, opts = {}) {
    const key = localStorage.getItem('soniox_api_key');
    if (!key) throw new Error('API 키가 설정되지 않았습니다.');
    const headers = { 'Authorization': `Bearer ${key}`, ...opts.headers };
    const res = await fetch(`${API_BASE}${endpoint}`, { ...opts, headers, signal: abortController?.signal });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `HTTP ${res.status}`);
    }
    if (opts.method === 'DELETE') return null;
    return res.json();
}

// ===== API Key =====
function initApiKey() {
    const input = $('#api-key-input');
    const saved = localStorage.getItem('soniox_api_key');
    if (saved) { input.value = saved; showApiKeyStatus('저장됨', 'saved'); updateGenerateBtn(); }
    $('#save-api-key').onclick = () => {
        const v = input.value.trim();
        if (!v) { showApiKeyStatus('API 키를 입력하세요.', 'error'); return; }
        localStorage.setItem('soniox_api_key', v);
        showApiKeyStatus('저장되었습니다!', 'saved');
        updateGenerateBtn();
    };
    $('#toggle-api-key').onclick = () => {
        input.type = input.type === 'password' ? 'text' : 'password';
    };
}
function showApiKeyStatus(msg, cls) {
    const el = $('#api-key-status');
    el.textContent = msg;
    el.className = `api-key-status ${cls}`;
}

// ===== File Upload =====
function initFileUpload() {
    const dz = $('#drop-zone'), fi = $('#file-input');
    dz.onclick = () => fi.click();
    fi.onchange = (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); };
    dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('dragover'); };
    dz.ondragleave = () => dz.classList.remove('dragover');
    dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('dragover'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); };
    $('#remove-file').onclick = () => {
        selectedFile = null; selectedFileDurationSec = null; cachedTokens = null; cachedWithTranslation = null;
        $('#file-info').style.display = 'none';
        $('#drop-zone').style.display = '';
        $('#file-input').value = '';
        updateGenerateBtn();
        updateCostEstimate();
    };
}
async function handleFile(file) {
    selectedFile = file;
    selectedFileDurationSec = null;
    cachedTokens = null;
    cachedWithTranslation = null;
    lastActualUsage = null;
    $('#file-name').textContent = file.name;
    $('#file-size').textContent = formatSize(file.size);
    $('#file-info').style.display = 'flex';
    $('#drop-zone').style.display = 'none';
    updateGenerateBtn();
    
    const el = $('#cost-estimate');
    if (el) {
        el.style.display = '';
        el.innerHTML = '<div class="cost-estimate-inner"><div class="cost-detail" style="padding: 6px;">미디어 길이를 분석하는 중...</div></div>';
    }

    selectedFileDurationSec = await getMediaDuration(file);
    if (selectedFile === file) {
        updateCostEstimate();
    }
}

function updateCostEstimate() {
    const el = $('#cost-estimate');
    if (!el) return;
    if (!selectedFile || selectedFileDurationSec === null) { el.style.display = 'none'; return; }
    const withTranslation = $('#enable-translation').checked;
    const est = estimateCostFromDuration(selectedFileDurationSec, withTranslation);
    const durStr = formatDuration(est.estimatedDurationSec);
    const costStr = formatCost(est.totalCost);
    el.style.display = '';
    el.innerHTML = `
        <div class="cost-estimate-inner">
            <div class="cost-icon">💰</div>
            <div class="cost-body">
                <div class="cost-label">예상 API 비용</div>
                <div class="cost-value">${costStr}</div>
                <div class="cost-detail">추정 재생 길이: ~${durStr} · 오디오 토큰: ~${Math.round(est.audioTokens).toLocaleString()}</div>
                ${withTranslation ? '<div class="cost-detail cost-detail-warning">번역 활성화로 비용이 증가합니다.</div>' : ''}
            </div>
        </div>
    `;
}

// ===== Custom Dictionary =====
function initDictionary() {
    const textarea = $('#custom-terms');
    const saved = localStorage.getItem('subforge_custom_terms');
    if (saved) textarea.value = saved;
    updateTermsCount();

    textarea.oninput = () => {
        localStorage.setItem('subforge_custom_terms', textarea.value);
        updateTermsCount();
        cachedTokens = null; // terms affect API result
    };
    $('#btn-clear-terms').onclick = () => {
        textarea.value = '';
        localStorage.removeItem('subforge_custom_terms');
        updateTermsCount();
        cachedTokens = null;
    };
}
function updateTermsCount() {
    const terms = getCustomTerms();
    $('#terms-count').textContent = `${terms.length}개 등록`;
}
function getCustomTerms() {
    const raw = $('#custom-terms').value.trim();
    if (!raw) return [];
    return raw.split('\n').map(t => t.trim()).filter(Boolean);
}

// ===== Settings =====
function initSettings() {
    const mc = $('#max-chars'), md = $('#max-duration'), mg = $('#min-gap');
    mc.oninput = () => { $('#max-chars-value').textContent = mc.value; };
    md.oninput = () => { $('#max-duration-value').textContent = md.value + '초'; };
    mg.oninput = () => { $('#min-gap-value').textContent = mg.value + 'ms'; };
    // Disable max-chars when split mode doesn't use it
    const updateMaxCharsState = () => {
        const mode = $('#split-mode').value;
        const disabled = mode === 'punctuation' || mode === 'sentence';
        mc.disabled = disabled;
        mc.closest('.setting-group').style.opacity = disabled ? '0.4' : '1';
        mc.closest('.setting-group').style.pointerEvents = disabled ? 'none' : '';
    };
    $('#split-mode').onchange = updateMaxCharsState;
    updateMaxCharsState();
    $('#speaker-diarization').onchange = (e) => {
        $('#speaker-label-group').style.display = e.target.checked ? 'flex' : 'none';
    };
    // Translation toggle — only invalidate cache when enabling (need new API call with translation)
    // When disabling, cached tokens already contain original data, no need to re-call
    $('#enable-translation').onchange = (e) => {
        $('#translation-lang-group').style.display = e.target.checked ? 'flex' : 'none';
        if (e.target.checked && cachedWithTranslation !== $('#translation-target').value) {
            cachedTokens = null; // need fresh API call with translation
        }
        updateCostEstimate();
    };
    // Invalidate cache only if translation is enabled and target language changed
    $('#translation-target').onchange = () => {
        if ($('#enable-translation').checked) cachedTokens = null;
        updateCostEstimate();
    };
}
function getSettings() {
    return {
        language: $('#language-hints').value,
        splitMode: $('#split-mode').value,
        maxChars: parseInt($('#max-chars').value),
        maxLines: parseInt($('#max-lines').value),
        maxDuration: parseFloat($('#max-duration').value) * 1000,
        minGap: parseInt($('#min-gap').value),
        speakerDiarization: $('#speaker-diarization').checked,
        includeSpeakerLabel: $('#include-speaker-label').checked,
        enableTranslation: $('#enable-translation').checked,
        translationTarget: $('#translation-target').value,
        extendSubtitles: $('#extend-subtitles').checked,
    };
}

// ===== Update Generate Button =====
function updateGenerateBtn() {
    const key = localStorage.getItem('soniox_api_key');
    $('#btn-generate').disabled = !(key && selectedFile);
}

// ===== Progress UI =====
function setProgress(step, pct, title, detail) {
    $('#progress-title').textContent = title;
    $('#progress-detail').textContent = detail;
    $('#progress-bar').style.width = pct + '%';
    const steps = ['upload', 'transcribe', 'generate', 'complete'];
    const idx = steps.indexOf(step);
    steps.forEach((s, i) => {
        const el = $(`#step-${s}`);
        el.className = 'progress-step' + (i < idx ? ' done' : i === idx ? ' active' : '');
    });
}

// ===== SRT Generation from Tokens =====
function tokensToWords(tokens) {
    const words = [];
    let current = null;
    for (const t of tokens) {
        let text = t.text;
        if (!text) continue;

        // If the token is just whitespace, append it and continue
        if (text.trim() === '') {
            if (current) { 
                current.text += text; 
                current.end_ms = t.end_ms; 
            }
            continue;
        }

        let startNewWord = false;
        
        // Case 1: Token starts with a space
        if (text.startsWith(' ')) {
            startNewWord = true;
            text = text.slice(1); // Remove leading space (join will add it back)
        } 
        // Case 2: Previous token ended with a space
        else if (current && current.text.endsWith(' ')) {
            startNewWord = true;
            current.text = current.text.trimEnd(); // Remove trailing space
        }

        if (startNewWord || !current) {
            if (current) words.push(current);
            current = { text: text, start_ms: t.start_ms, end_ms: t.end_ms, speaker: t.speaker || null };
        } else {
            current.text += text;
            current.end_ms = t.end_ms;
            if (t.speaker) current.speaker = t.speaker;
        }
    }
    if (current) {
        current.text = current.text.trimEnd();
        words.push(current);
    }
    return words;
}

function isPunctuation(ch) {
    return /[.!?。！？，,;:；：、\n]/.test(ch);
}

function isSentenceEnd(ch) {
    return /[.!?。！？]/.test(ch);
}

function buildSubtitles(tokens, settings) {
    const words = tokensToWords(tokens);
    if (words.length === 0) return [];
    const subs = [];
    let buf = [];
    let lineLen = 0;

    const flush = () => {
        if (buf.length === 0) return;
        let text = buf.map(w => w.text).join(' ');
        if (settings.speakerDiarization && settings.includeSpeakerLabel && buf[0].speaker) {
            text = `[${buf[0].speaker}] ${text}`;
        }
        if (settings.maxLines > 1 && text.length > settings.maxChars) {
            const mid = Math.ceil(text.length / settings.maxLines);
            const lines = [];
            let pos = 0;
            for (let l = 0; l < settings.maxLines && pos < text.length; l++) {
                let end = Math.min(pos + mid, text.length);
                if (l < settings.maxLines - 1 && end < text.length) {
                    let sp = text.lastIndexOf(' ', end);
                    if (sp > pos) end = sp;
                }
                lines.push(text.slice(pos, end).trim());
                pos = end + (text[end] === ' ' ? 1 : 0);
            }
            text = lines.filter(Boolean).join('\n');
        }
        subs.push({
            start_ms: buf[0].start_ms,
            end_ms: buf[buf.length - 1].end_ms,
            text: text,
        });
        buf = [];
        lineLen = 0;
    };

    for (const word of words) {
        const wLen = word.text.length;
        const currentLen = buf.length > 0 ? lineLen + 1 + wLen : wLen;
        const currentDur = buf.length > 0 ? word.end_ms - buf[0].start_ms : 0;

        if (settings.speakerDiarization && buf.length > 0 && word.speaker !== buf[buf.length-1].speaker) {
            flush();
        }

        // Enforce char limit and duration limit across all modes to ensure readability
        const shouldFlush = buf.length > 0 && (
            currentLen > settings.maxChars || currentDur > settings.maxDuration
        );

        // Smart flush: try to break at a natural point (punctuation) instead of hard-cutting
        if (shouldFlush && buf.length > 1) {
            // Look backwards for a natural break point (comma, period, etc.)
            let bestBreak = -1;
            const searchStart = Math.max(1, Math.floor(buf.length * 0.4)); // search last 60%
            for (let i = buf.length - 1; i >= searchStart; i--) {
                const lastCh = buf[i].text.slice(-1);
                if (isPunctuation(lastCh)) {
                    bestBreak = i;
                    break;
                }
            }
            if (bestBreak >= 0) {
                // Flush up to the natural break, carry the rest forward
                const carry = buf.splice(bestBreak + 1);
                flush();
                buf = carry;
                lineLen = buf.map(w => w.text).join(' ').length;
            } else {
                flush();
            }
        } else if (shouldFlush) {
            flush();
        }

        buf.push(word);
        lineLen = buf.map(w => w.text).join(' ').length;

        const lastChar = word.text.slice(-1);
        if (settings.splitMode === 'punctuation' && isPunctuation(lastChar)) {
            flush();
        } else if (settings.splitMode === 'sentence' && isSentenceEnd(lastChar)) {
            flush();
        } else if (settings.splitMode === 'hybrid' && isSentenceEnd(lastChar)) {
            // Hybrid: always flush on sentence end — char limit is a separate safety net
            flush();
        } else if (settings.splitMode === 'length' && isSentenceEnd(lastChar) && lineLen >= settings.maxChars * 0.5) {
            // Length mode: still be sentence-aware when we have enough text (>50%)
            flush();
        }
    }
    flush();

    for (let i = 1; i < subs.length; i++) {
        if (subs[i].start_ms - subs[i-1].end_ms < settings.minGap) {
            subs[i-1].end_ms = subs[i].start_ms - settings.minGap;
            if (subs[i-1].end_ms < subs[i-1].start_ms) subs[i-1].end_ms = subs[i-1].start_ms;
        }
    }

    // Extend subtitles to fill gaps (show previous subtitle until next one starts)
    if (settings.extendSubtitles) {
        for (let i = 0; i < subs.length - 1; i++) {
            subs[i].end_ms = subs[i + 1].start_ms;
        }
    }

    return subs;
}

// ===== Separate original and translation tokens =====
function splitTokensByTranslation(tokens) {
    const original = [];
    const translatedBlocks = [];
    
    let currentTranslatedBlock = [];
    let blockStartMs = 0;
    let blockEndMs = 0;
    let inTranslationBlock = false;

    for (const t of tokens) {
        if (t.translation_status === 'translation') {
            inTranslationBlock = true;
            currentTranslatedBlock.push({ ...t });
        } else {
            if (inTranslationBlock) {
                // Started a new block of original tokens -> save previous translation block
                if (currentTranslatedBlock.length > 0) {
                    translatedBlocks.push({ start: blockStartMs, end: blockEndMs, tokens: currentTranslatedBlock });
                    currentTranslatedBlock = [];
                }
                inTranslationBlock = false;
                blockStartMs = t.start_ms || 0;
            } else if (original.length === 0) {
                blockStartMs = t.start_ms || 0;
            }
            if (t.end_ms) blockEndMs = t.end_ms;
            
            // Default original tokens
            original.push(t);
        }
    }
    // Flush the final translation block if exists
    if (inTranslationBlock && currentTranslatedBlock.length > 0) {
        translatedBlocks.push({ start: blockStartMs, end: blockEndMs, tokens: currentTranslatedBlock });
    }

    // Linearly interpolate timestamps for translation tokens based on character length
    const translated = [];
    for (const block of translatedBlocks) {
        const duration = block.end - block.start;
        const totalChars = block.tokens.reduce((sum, t) => sum + (t.text ? t.text.length : 0), 0);
        let currentMs = block.start;
        
        for (const t of block.tokens) {
            const charLen = t.text ? t.text.length : 0;
            const tDur = totalChars > 0 ? (charLen / totalChars) * duration : 0;
            
            // Assign interpolated times if missing or 0
            if (!t.end_ms || (t.start_ms === 0 && t.end_ms === 0)) {
                t.start_ms = Math.round(currentMs);
                t.end_ms = Math.round(currentMs + tDur);
            }
            currentMs += tDur;
            translated.push(t);
        }
    }

    return { original, translated };
}

function subtitlesToSrt(subs) {
    return subs.map((s, i) =>
        `${i + 1}\n${msToSrt(s.start_ms)} --> ${msToSrt(s.end_ms)}\n${s.text}\n`
    ).join('\n');
}

function subtitlesToTxt(subs) {
    return subs.map(s => s.text).join('\n');
}

// ===== Main Pipeline =====
async function runPipeline() {
    const settings = getSettings();
    abortController = new AbortController();
    const ps = $('#progress-section');
    const rs = $('#result-section');
    ps.style.display = ''; rs.style.display = 'none';
    $('#btn-cancel').style.display = '';
    $('#btn-generate').disabled = true;

    let fileId = null, transcriptionId = null;

    try {
        // If we have cached tokens and just changed settings (not translation), skip API calls
        if (cachedTokens) {
            setProgress('generate', 80, 'SRT 생성 중...', '설정에 맞게 자막을 분할하고 있습니다.');
            await new Promise(r => setTimeout(r, 300));
            processTokensAndShow(cachedTokens, settings);
            return;
        }

        // Step 1: Upload
        setProgress('upload', 10, '파일 업로드 중...', `${selectedFile.name} (${formatSize(selectedFile.size)})`);
        const formData = new FormData();
        formData.append('file', selectedFile);
        const uploadRes = await apiFetch('/v1/files', { method: 'POST', body: formData });
        fileId = uploadRes.id;
        setProgress('upload', 25, '업로드 완료', '음성 인식을 시작합니다.');

        // Step 2: Create transcription (with translation config if enabled)
        const detail = settings.enableTranslation ? 'Soniox AI가 음성 인식 + 번역을 수행합니다.' : 'Soniox AI가 음성을 분석합니다.';
        setProgress('transcribe', 30, '음성 인식 요청 중...', detail);
        const config = { model: 'stt-async-preview', file_id: fileId };
        if (settings.language) config.language_hints = [settings.language];
        if (settings.speakerDiarization) config.enable_speaker_diarization = true;

        // Add custom terms for better recognition
        const customTerms = getCustomTerms();
        if (customTerms.length > 0) {
            config.context = { terms: customTerms };
        }

        // Add translation config (one_way: translates all into target language)
        if (settings.enableTranslation) {
            config.translation = {
                type: 'one_way',
                target_language: settings.translationTarget,
            };
        }

        const txRes = await apiFetch('/v1/transcriptions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config),
        });
        transcriptionId = txRes.id;

        // Step 3: Poll for completion (exponential backoff: 1.5s → 2s → 3s → 5s max)
        let status = 'queued';
        let pollCount = 0;
        let finalPoll = null;
        const pollIntervals = [1500, 2000, 2000, 3000, 3000, 5000]; // then stay at 5s
        while (status !== 'completed' && status !== 'error') {
            const interval = pollIntervals[Math.min(pollCount, pollIntervals.length - 1)];
            await new Promise(r => setTimeout(r, interval));
            const poll = await apiFetch(`/v1/transcriptions/${transcriptionId}`);
            status = poll.status;
            finalPoll = poll;
            pollCount++;
            const pct = Math.min(30 + pollCount * 5, 70);
            const statusText = status === 'queued' ? '대기열에서 처리 대기 중...' : '음성을 텍스트로 변환 중...';
            setProgress('transcribe', pct, '음성 인식 중...', statusText);
            if (status === 'error') throw new Error(poll.error_message || '음성 인식 실패');
        }

        // Step 4: Get transcript
        setProgress('generate', 75, '결과 가져오는 중...', '음성 인식 결과를 다운로드합니다.');
        const transcript = await apiFetch(`/v1/transcriptions/${transcriptionId}/transcript`);
        cachedTokens = transcript.tokens;
        cachedWithTranslation = settings.enableTranslation ? settings.translationTarget : null;
        
        // Save actual usage info from the final poll response if available
        if (finalPoll && finalPoll.input_audio_tokens !== undefined) {
            lastActualUsage = {
                input_audio_tokens: finalPoll.input_audio_tokens,
                input_text_tokens: finalPoll.input_text_tokens,
                output_text_tokens: finalPoll.output_text_tokens,
                api_provided_cost: {
                    audioCost: parseFloat(finalPoll.input_audio_cost_usd || 0),
                    inputTextCost: parseFloat(finalPoll.input_text_cost_usd || 0),
                    outputTextCost: parseFloat(finalPoll.output_text_cost_usd || 0),
                    totalCost: parseFloat(finalPoll.cost_usd || 0)
                }
            };
        } else {
            // Calculate exact tokens using duration and actual generated token count
            const durationMs = selectedFileDurationSec * 1000;
            // 1 hour (3,600,000ms) = 30,000 tokens => duration_ms / 120
            const calculatedAudioTokens = Math.round(durationMs / 120);
            const calculatedOutputTokens = cachedTokens ? cachedTokens.length : 0;
            const termsLength = getCustomTerms().join(' ').length;
            const calculatedInputTextTokens = termsLength > 0 ? Math.max(1, Math.round(termsLength / 4)) : 0;
            
            lastActualUsage = {
                input_audio_tokens: calculatedAudioTokens,
                input_text_tokens: calculatedInputTextTokens,
                output_text_tokens: calculatedOutputTokens
            };
        }

        // Step 5: Build SRT(s)
        setProgress('generate', 85, 'SRT 생성 중...', '설정에 맞게 자막을 분할하고 있습니다.');
        processTokensAndShow(cachedTokens, settings);
        showToast('자막이 성공적으로 생성되었습니다!', 'success');

    } catch (err) {
        if (err.name === 'AbortError') {
            showToast('작업이 취소되었습니다.', 'info');
        } else {
            showToast(`오류: ${err.message}`, 'error');
        }
        ps.style.display = 'none';
    } finally {
        try {
            if (transcriptionId) await apiFetch(`/v1/transcriptions/${transcriptionId}`, { method: 'DELETE' }).catch(() => {});
            if (fileId) await apiFetch(`/v1/files/${fileId}`, { method: 'DELETE' }).catch(() => {});
        } catch (e) { /* ignore cleanup errors */ }
        $('#btn-generate').disabled = false;
        $('#btn-cancel').style.display = 'none';
        abortController = null;
        updateGenerateBtn();
    }
}

// ===== Process Tokens & Show Result =====
function processTokensAndShow(tokens, settings) {
    const hasTranslation = settings.enableTranslation && tokens.some(t => t.translation_status === 'translation');

    if (hasTranslation) {
        const { original, translated } = splitTokensByTranslation(tokens);
        lastOriginalSubs = buildSubtitles(original, settings);
        lastTranslatedSubs = buildSubtitles(translated, settings);
        lastOriginalSrt = subtitlesToSrt(lastOriginalSubs);
        lastTranslatedSrt = subtitlesToSrt(lastTranslatedSubs);
    } else {
        lastOriginalSubs = buildSubtitles(tokens, settings);
        lastTranslatedSubs = null;
        lastOriginalSrt = subtitlesToSrt(lastOriginalSubs);
        lastTranslatedSrt = '';
    }

    const totalBlocks = lastOriginalSubs.length + (lastTranslatedSubs ? lastTranslatedSubs.length : 0);
    setProgress('complete', 100, '완료!', `${lastOriginalSubs.length}개의 원문 자막 블록` + (lastTranslatedSubs ? ` + ${lastTranslatedSubs.length}개의 번역 자막 블록` : '') + ' 생성');
    setTimeout(() => showResult(), 500);
}

// ===== Show Result =====
function showResult() {
    $('#progress-section').style.display = 'none';
    $('#result-section').style.display = '';
    const subs = lastOriginalSubs;
    const totalDur = subs.length > 0 ? subs[subs.length-1].end_ms : 0;
    const durStr = msToSrt(totalDur).slice(0, 8);

    let statsText = `${subs.length}개 자막 블록 · 전체 길이 ${durStr}`;
    if (lastTranslatedSubs) {
        statsText += ` · 번역 ${lastTranslatedSubs.length}블록`;
    }
    $('#result-stats').textContent = statsText;

    // Show actual cost if we have usage data
    renderActualCost();

    // Show/hide translation elements
    const hasTranslated = !!lastTranslatedSubs;
    $('#btn-download-translated').style.display = hasTranslated ? '' : 'none';
    $('#tab-translated').style.display = hasTranslated ? '' : 'none';

    // Reset to original tab
    currentPreviewTab = 'original';
    $('#tab-original').classList.add('active');
    $('#tab-translated').classList.remove('active');
    renderPreview(lastOriginalSubs);

    // Tab switching
    $('#tab-original').onclick = () => {
        currentPreviewTab = 'original';
        $('#tab-original').classList.add('active');
        $('#tab-translated').classList.remove('active');
        renderPreview(lastOriginalSubs, $('#srt-search').value.trim().toLowerCase());
    };
    $('#tab-translated').onclick = () => {
        if (!lastTranslatedSubs) return;
        currentPreviewTab = 'translated';
        $('#tab-translated').classList.add('active');
        $('#tab-original').classList.remove('active');
        renderPreview(lastTranslatedSubs, $('#srt-search').value.trim().toLowerCase());
    };

    // Download original SRT
    $('#btn-download').onclick = () => downloadFile(lastOriginalSrt, getBaseName() + '.srt', 'text/srt');
    // Download translated SRT
    $('#btn-download-translated').onclick = () => {
        const settings = getSettings();
        const langSuffix = settings.translationTarget || 'translated';
        downloadFile(lastTranslatedSrt, getBaseName() + `_${langSuffix}.srt`, 'text/srt');
    };
    // Download TXT
    $('#btn-download-txt').onclick = () => downloadFile(subtitlesToTxt(lastOriginalSubs), getBaseName() + '.txt', 'text/plain');
    // Copy (current tab)
    $('#btn-copy').onclick = () => {
        const srt = currentPreviewTab === 'translated' ? lastTranslatedSrt : lastOriginalSrt;
        navigator.clipboard.writeText(srt).then(() => showToast('클립보드에 복사되었습니다!', 'success'));
    };
    // Regenerate
    $('#btn-regenerate').onclick = () => {
        $('#result-section').style.display = 'none';
        window.scrollTo({ top: $('#settings-section').offsetTop - 80, behavior: 'smooth' });
    };
    // Search
    $('#srt-search').oninput = (e) => {
        const q = e.target.value.trim().toLowerCase();
        const subs = currentPreviewTab === 'translated' ? lastTranslatedSubs : lastOriginalSubs;
        renderPreview(subs || lastOriginalSubs, q);
    };
}

function renderActualCost() {
    const el = $('#actual-cost');
    if (!el) return;
    const actual = calcActualCost(lastActualUsage);
    if (!actual) {
        // No usage data from API — show estimate based on file
        if (selectedFile && selectedFileDurationSec !== null) {
            const withTranslation = lastTranslatedSubs !== null;
            const est = estimateCostFromDuration(selectedFileDurationSec, withTranslation);
            el.style.display = '';
            el.innerHTML = `
                <div class="actual-cost-inner estimate-only">
                    <div class="cost-icon">💡</div>
                    <div class="cost-body">
                        <div class="cost-label">API 비용 (추정)</div>
                        <div class="cost-value">${formatCost(est.totalCost)}</div>
                        <div class="cost-detail">실제 토큰 데이터를 받지 못했습니다. 파일 크기 기반 추정치입니다.</div>
                    </div>
                </div>
            `;
        } else {
            el.style.display = 'none';
        }
        return;
    }

    el.style.display = '';
    el.innerHTML = `
        <div class="actual-cost-inner">
            <div class="cost-icon">✅</div>
            <div class="cost-body">
                <div class="cost-label">실제 사용 비용</div>
                <div class="cost-value actual">${formatCost(actual.totalCost)}</div>
                <div class="cost-breakdown">
                    <span class="breakdown-item">🎙️ 오디오 ${actual.audioTokens.toLocaleString()}토큰 → ${formatCost(actual.audioCost)}</span>
                    ${actual.inputTextTokens > 0 ? `<span class="breakdown-item">📝 입력텍스트 ${actual.inputTextTokens.toLocaleString()}토큰 → ${formatCost(actual.inputTextCost)}</span>` : ''}
                    <span class="breakdown-item">📄 출력텍스트 ${actual.outputTextTokens.toLocaleString()}토큰 → ${formatCost(actual.outputTextCost)}</span>
                </div>
            </div>
        </div>
    `;
}

function renderPreview(subs, query = '') {
    const container = $('#srt-content');
    container.innerHTML = '';
    subs.forEach((s, i) => {
        let textHtml = escapeHtml(s.text);
        if (query) {
            const re = new RegExp(`(${escapeRegExp(query)})`, 'gi');
            textHtml = textHtml.replace(re, '<span class="srt-highlight">$1</span>');
        }
        const block = document.createElement('div');
        block.className = 'srt-block';
        block.innerHTML = `<span class="srt-index">${i+1}</span>\n<span class="srt-time">${msToSrt(s.start_ms)} --> ${msToSrt(s.end_ms)}</span>\n<span class="srt-text">${textHtml.replace(/\n/g, '<br>')}</span>`;
        container.appendChild(block);
    });
}

function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function getBaseName() { return selectedFile ? selectedFile.name.replace(/\.[^.]+$/, '') : 'subtitle'; }
function downloadFile(content, name, type) {
    const blob = new Blob([content], { type: type + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    initApiKey();
    initFileUpload();
    initDictionary();
    initSettings();
    $('#btn-generate').onclick = runPipeline;
    $('#btn-cancel').onclick = () => { if (abortController) abortController.abort(); };
});
