// ======= FORCED UNLOCK FOR ALL USERS (no Supabase) =======
let supabase = null;
let isAuthed = true; // FORCE: treat everyone as authenticated

// Lock/unlock UI based on auth (forced-unlock version)
function applyAuthGate() {
  // enable all interactive controls
  const btns = document.querySelectorAll(
    '.main-looper-btn, .stop-btn, .fx-menu-btn, .before-fx-row .before-fx-btn, #monitorBtn'
  );
  btns.forEach(b => { if (b) b.disabled = false; });

  // If loopers exist, enable them and remove master-lock
  if (window.loopers && loopers.length) {
    for (let i = 1; i <= 4; i++) {
      if (!loopers[i]) continue;
      // always enable (allow overdub/record for all tracks)
      loopers[i].disable(false);
    }
  }

  // hide auth gate overlay if present
  const g = document.getElementById('authGate');
  if (g) g.classList.add('hidden');

  // hide auth controls and premium CTA
  const authControls = document.getElementById('authControls');
  if (authControls) authControls.style.display = 'none';
  const premiumBtn = document.getElementById('openPremiumModal');
  if (premiumBtn) premiumBtn.classList.add('hidden');

  // mark page premium
  document.body.dataset.premium = "1";
  // update ad badge if exists
  const badge = document.getElementById("ad-minutes-left");
  if (badge) badge.textContent = "✅ Unlocked";
}

// Minimal stub init (no remote auth)
async function initAuth() {
  // no-op supabase client; we keep variable for compatibility
  supabase = null;
  isAuthed = true;
  applyAuthGate();

  // update header badge if present
  const userBadge = document.getElementById("userBadge");
  if (userBadge) {
    userBadge.classList.remove('hidden');
    userBadge.textContent = "Unlocked";
  }

  // hide login/signup/logout buttons if present
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const signupBtn = document.getElementById("signupBtn");
  if (loginBtn) loginBtn.classList.add("hidden");
  if (signupBtn) signupBtn.classList.add("hidden");
  if (logoutBtn) logoutBtn.classList.add("hidden");
}

// Make requireAuth always allow (used by many flows)
async function requireAuth() {
  // ensure UI is initialized
  if (!document.body.dataset.premium) initAuth();
  return true;
}

// Stub entitlement functions (no server)
async function refreshEntitlementUI() {
  // Always premium
  document.body.dataset.premium = "1";
  applyAuthGate();
  const badge = document.getElementById("ad-minutes-left");
  if (badge) badge.textContent = "✅ Unlocked";
}
async function grantAdCredit(seconds = 300) {
  // grant has no persistent effect in this stub, just set badge
  const badge = document.getElementById("ad-minutes-left");
  if (badge) badge.textContent = `Simulated ${Math.ceil(seconds/60)} min`;
  document.body.dataset.premium = "1";
  applyAuthGate();
}
async function consumeAllCredits() {
  // no-op in unlocked mode
  const badge = document.getElementById("ad-minutes-left");
  if (badge) badge.textContent = "";
  document.body.dataset.premium = "1";
  applyAuthGate();
}

// Run init
if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", initAuth);
} else {
  initAuth();
}


// Wire the premium modal open/close but hide the CTA if present
(function premiumModalWiring(){
  const openBtn   = document.getElementById('openPremiumModal');
  const modal     = document.getElementById('premiumModal');
  const overlay   = document.getElementById('premiumModalOverlay');
  const closeBtn  = document.getElementById('premiumModalClose');

  function openModal() {
    if (window.refreshEntitlementUI) refreshEntitlementUI();
    overlay?.classList.remove('hidden');
    modal?.classList.remove('hidden');
    document.body.classList.add('modal-open');   // lock background scroll
  }

  function closeModal() {
    overlay?.classList.add('hidden');
    modal?.classList.add('hidden');
    document.body.classList.remove('modal-open'); // unlock background scroll
  }

  openBtn?.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  overlay?.addEventListener('click', closeModal);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // hide the Go Premium CTA in forced-unlock mode
  if (openBtn) openBtn.classList.add('hidden');
})();

// Premium purchase wiring stub (no-op handlers but safe)
(function premiumPurchaseWiring(){
  const watchAdBtn = document.getElementById('watchAdBtn');
  const buyDaily   = document.getElementById('buy-daily');
  const buyMonthly = document.getElementById('buy-monthly');
  const buyYearly  = document.getElementById('buy-yearly');

  async function requireUserOrAlert(){
    // In unlocked mode, just return a fake user object
    await requireAuth();
    return { id: 'unlocked', email: 'unlocked@local' };
  }

  // Watch ad (simulated)
  watchAdBtn?.addEventListener('click', async ()=>{
    const user = await requireUserOrAlert();
    if (!user) return;
    if (!confirm('Simulate watching a rewarded ad for 5 minutes?')) return;
    await grantAdCredit(300);
    await refreshEntitlementUI();
    alert('Unlocked for 5 minutes (simulated).');
  });

  // Buy handlers: show friendly message (no real payments)
  async function startCheckout(planKey){
    const user = await requireUserOrAlert();
    if (!user) return;
    alert(`Payments are disabled in development/unlocked mode. Selected plan: ${planKey}`);
    // pretend success
    document.body.dataset.premium = "1";
    await refreshEntitlementUI();
    document.getElementById('premiumModalClose')?.click();
  }

  buyDaily?.addEventListener('click', ()=>startCheckout('daily'));
  buyMonthly?.addEventListener('click', ()=>startCheckout('monthly'));
  buyYearly?.addEventListener('click', ()=>startCheckout('yearly'));

  // hide buy buttons if present (UI cleanup)
  if (buyDaily) buyDaily.style.display = 'none';
  if (buyMonthly) buyMonthly.style.display = 'none';
  if (buyYearly) buyYearly.style.display = 'none';
})();

/* Looper Pedal Board – Popups + Programmable FX Chains (Before + After)
   - Before-FX: popup with per-effect parameters
   - After-FX: menu popup to add/remove/reorder effects (series), second popup to tweak parameters
   - Up/Down reordering with numbers
   - Pitch (playbackRate) available in After-FX; live input pitch shifting is NOT implemented
   Date: 2025-08-09
*/

let audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
let micStream = null, micSource = null;

// ======= GLOBAL (Before-FX) GRAPH =======
let dryGain, fxSumGain, mixDest, processedStream;

// Reverb (Before)
let convolver, reverbPreDelay, reverbWet;
let reverbMix = 0.25, reverbRoomSeconds = 2.5, reverbDecay = 2.0, reverbPreDelayMs = 20;

// Delay (Before)
let delayNode, delayFeedback, delayWet;
let delayMix = 0.25, delayFeedbackAmt = 0.35;
let delaySyncMode = 'note';     // 'note' | 'ms'
let delayDivision = '1/8';      // tempo divisions
let delayVariant = 'straight';  // straight | dotted | triplet
let delayMs = 250;

// Flanger (Before)
let flangerDelay, flangerWet, flangerFeedback, flangerLFO, flangerDepthGain;
let flangerMix = 0.22, flangerRateHz = 0.25, flangerDepthMs = 2.0, flangerFeedbackAmt = 0.0;

// EQ (Before, series)
let eq = null;
let eqLowGain = 3, eqMidGain = 2, eqMidFreq = 1200, eqMidQ = 0.9, eqHighGain = 3;

// Before-FX state (ON/OFF)
const beforeState = { delay:false, reverb:false, flanger:false, eq5:false };

// Live monitor
let liveMicMonitorGain = null, liveMicMonitoring = false;

// Master timing from track 1
let masterLoopDuration = null, masterBPM = null, masterIsSet = false;

// ======= DOM SHORTCUTS =======
const $ = s => document.querySelector(s);
const bpmLabel = $('#bpmLabel');
const dividerSelectors = [ null, null, $('#divider2'), $('#divider3'), $('#divider4') ];

// ======= HELPERS =======
function showMsg(msg, color='#ff4444'){
  let el = $('#startMsg');
  if (!el){ el = document.createElement('div'); el.id='startMsg'; document.body.prepend(el); }
  Object.assign(el.style, {
    display:'block', color, background:'#111a22cc', fontWeight:'bold', borderRadius:'12px',
    padding:'12px 22px', position:'fixed', left:'50%', top:'8%', transform:'translate(-50%,0)',
    zIndex:1000, textAlign:'center'
  });
  el.innerHTML = msg;
}
function hideMsg(){ const el = $('#startMsg'); if (el) el.style.display='none'; }
function addTap(btn, fn){ if(!btn) return; btn.addEventListener('click', fn); btn.addEventListener('touchstart', e=>{e.preventDefault();fn(e);},{passive:false}); }
function addHold(btn, onStart, onEnd){
  let hold=false;
  btn.addEventListener('mousedown', e=>{ hold=true; onStart(e); });
  btn.addEventListener('touchstart', e=>{ hold=true; onStart(e); }, {passive:false});
  ['mouseup','mouseleave'].forEach(ev=>btn.addEventListener(ev, e=>{ if(hold) onEnd(e); hold=false; }));
  ['touchend','touchcancel'].forEach(ev=>btn.addEventListener(ev, e=>{ if(hold) onEnd(e); hold=false; }, {passive:false}));
}
function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }
function debounce(fn, ms=130){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

// Reverb IR (simple algorithmic room)
function makeReverbImpulse(seconds, decay){
  const sr = audioCtx.sampleRate, len = Math.max(1, Math.floor(sr*seconds));
  const buf = audioCtx.createBuffer(2, len, sr);
  for (let ch=0; ch<2; ch++){
    const d = buf.getChannelData(ch);
    for (let i=0;i<len;i++){
      const t = i/len;
      d[i] = (Math.random()*2-1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

// Tempo helpers
const NOTE_MULT = { '1/1':4, '1/2':2, '1/4':1, '1/8':0.5, '1/16':0.25, '1/32':0.125 };
function quarterSecForBPM(bpm){ return 60/(bpm||120); }
function applyVariant(mult, v){ return v==='dotted' ? mult*1.5 : v==='triplet' ? mult*(2/3) : mult; }

// ======= AUDIO SETUP =======
async function ensureMic(){
  // 🔐 Require login before enabling microphone
  if (!(await requireAuth())) return;

  if (micStream) return;
  if (!navigator.mediaDevices?.getUserMedia) { showMsg('❌ Microphone not supported'); throw new Error('gUM'); }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:false } });
  } catch(e){ showMsg('❌ Microphone access denied'); throw e; }
  audioCtx.resume();
  micSource = audioCtx.createMediaStreamSource(micStream);

  // Initialize latency module now that we have the context and stream
  if (window.latency && typeof window.latency.init === 'function') {
      try {
          latency.init(audioCtx, micStream);
          console.log('Latency module initialized.');
      } catch(e) {
          console.error('Failed to initialize latency module:', e);
      }
  }

  // init low-latency recorder (AudioWorklet) if available (recorder.js must be loaded)
  if (window.LooperRecorder && !window._globalLooperRecorder) {
    try {
      window._globalLooperRecorder = new LooperRecorder(audioCtx, micSource, { channels: 1 });
      await window._globalLooperRecorder.init();
      console.log('LooperRecorder ready');

      // Handler to receive raw Float32 channels from the worklet recorder
      window._globalLooperRecorder.ondata = (channels) => {
        // channels -> Array of Float32Array per channel (mono = channels[0])
        // Find which looper is currently overdubbing (state==='overdub' or 'prerecord')
        const active = window.loopers?.find(lp => lp && (lp.state==='overdub' || lp.state==='prerecord'));
        if (!active) {
          console.warn('No active looper found when recorder flushed');
          return;
        }

        try {
          const recorded = channels[0] || new Float32Array(0);
          const sr = active.loopBuffer ? active.loopBuffer.sampleRate : audioCtx.sampleRate;
          const masterLen = active.loopBuffer ? active.loopBuffer.length : Math.round((active.loopDuration || recorded.length/sr) * sr);
          const outC = Math.max(active.loopBuffer ? active.loopBuffer.numberOfChannels : 1, 1);

          // compute nudge / prerecord samples
          const nudgeSamples = Math.round((active.manualNudgeMs||0)/1000 * sr);
          const prerecordSamples = Math.round((active.prerecordMs||150)/1000 * sr);

          // compute start sample relative to master loop using overdubStartAudioTime
          let startSample = 0;
          if (active.overdubStartAudioTime && loopers[1] && loopers[1].loopStartTime && masterLoopDuration) {
            const relative = (active.overdubStartAudioTime - loopers[1].loopStartTime);
            const wrappedSec = ((relative % masterLoopDuration) + masterLoopDuration) % masterLoopDuration;
            startSample = Math.round(wrappedSec * sr) + nudgeSamples - prerecordSamples;
          } else {
            // fallback: align recorded tail to end of master block, then apply nudge & prerecord
            startSample = recorded.length - masterLen + nudgeSamples - prerecordSamples;
          }

          // create output buffer (same length as master) and copy original
          const out = audioCtx.createBuffer(outC, masterLen, sr);
          for (let ch=0; ch<outC; ch++){
            const outD = out.getChannelData(ch);
            if (active.loopBuffer && active.loopBuffer.numberOfChannels > ch){
              const orig = active.loopBuffer.getChannelData(ch);
              outD.set(orig.subarray(0, masterLen));
            } else if (active.loopBuffer && active.loopBuffer.numberOfChannels > 0){
              // fallback copy channel 0
              const orig = active.loopBuffer.getChannelData(0);
              outD.set(orig.subarray(0, masterLen));
            } else {
              for (let i=0;i<masterLen;i++) outD[i]=0;
            }
          }

          // overlay recorded samples with wrap-around (module write)
          const recLen = recorded.length;
          for (let i=0;i<recLen;i++){
            let writeIdx = startSample + i;
            writeIdx = ((writeIdx % masterLen) + masterLen) % masterLen; // positive modulo
            for (let ch=0; ch<out.numberOfChannels; ch++){
              // if recorded is mono, use same channel
              const recSample = recorded[i] || 0;
              out.getChannelData(ch)[writeIdx] += recSample * (active.overdubGain||1.0);
            }
          }

          // simple clipping protection
          for (let ch=0; ch<out.numberOfChannels; ch++){
            const d = out.getChannelData(ch);
            for (let i=0;i<d.length;i++){
              if (d[i] > 1) d[i] = 1;
              else if (d[i] < -1) d[i] = -1;
            }
          }

          // update looper buffer and restart playback
          active.loopBuffer = out;
          active.loopDuration = out.duration;
          active.overdubStartAudioTime = null;
          active.state='playing';
          active.updateUI();
          active.startPlayback();
        } catch (err) {
          console.error('Error merging overdub data', err);
          active.state='playing';
          active.updateUI();
        }
      };

    } catch (err) {
      console.warn('LooperRecorder init failed - falling back to MediaRecorder if used', err);
      window._globalLooperRecorder = null;
    }
  }


  dryGain = audioCtx.createGain();   dryGain.gain.value = 1;
  fxSumGain = audioCtx.createGain(); fxSumGain.gain.value = 1;

  // --- Reverb path ---
  reverbPreDelay = audioCtx.createDelay(1.0); reverbPreDelay.delayTime.value = reverbPreDelayMs/1000;
  convolver = audioCtx.createConvolver(); convolver.normalize = true; convolver.buffer = makeReverbImpulse(reverbRoomSeconds, reverbDecay);
  reverbWet = audioCtx.createGain(); reverbWet.gain.value = 0;
  micSource.connect(reverbPreDelay); reverbPreDelay.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(fxSumGain);

  // --- Delay path ---
  delayNode = audioCtx.createDelay(2.0);
  delayFeedback = audioCtx.createGain(); delayFeedback.gain.value = delayFeedbackAmt;
  delayWet = audioCtx.createGain(); delayWet.gain.value = 0;
  delayNode.connect(delayFeedback); delayFeedback.connect(delayNode);
  micSource.connect(delayNode); delayNode.connect(delayWet); delayWet.connect(fxSumGain);

  // --- Flanger path ---
  flangerDelay = audioCtx.createDelay(0.05);
  flangerWet = audioCtx.createGain(); flangerWet.gain.value = 0;
  flangerFeedback = audioCtx.createGain(); flangerFeedback.gain.value = flangerFeedbackAmt;
  flangerLFO = audioCtx.createOscillator(); flangerLFO.type='sine'; flangerLFO.frequency.value = flangerRateHz;
  flangerDepthGain = audioCtx.createGain(); flangerDepthGain.gain.value = flangerDepthMs/1000;
  flangerLFO.connect(flangerDepthGain); flangerDepthGain.connect(flangerDelay.delayTime);
  flangerDelay.connect(flangerWet); flangerWet.connect(fxSumGain);
  flangerDelay.connect(flangerFeedback); flangerFeedback.connect(flangerDelay);
  micSource.connect(flangerDelay); flangerLFO.start();

  // EQ (created when toggled on)
  eq = null;

  micSource.connect(dryGain);

  // Recording
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest); fxSumGain.connect(mixDest);
  processedStream = mixDest.stream;

  // Live monitor
  liveMicMonitorGain = audioCtx.createGain(); liveMicMonitorGain.gain.value = 0;
  dryGain.connect(liveMicMonitorGain); fxSumGain.connect(liveMicMonitorGain); liveMicMonitorGain.connect(audioCtx.destination);

  hideMsg();
}

function toggleEQ(enable){
  if (!micSource) return;
  if (enable && !eq){
    eq = {
      low: audioCtx.createBiquadFilter(), mid: audioCtx.createBiquadFilter(), high: audioCtx.createBiquadFilter()
    };
    eq.low.type='lowshelf'; eq.low.frequency.value=180; eq.low.gain.value=eqLowGain;
    eq.mid.type='peaking';  eq.mid.frequency.value=eqMidFreq; eq.mid.Q.value=eqMidQ; eq.mid.gain.value=eqMidGain;
    eq.high.type='highshelf'; eq.high.frequency.value=4500; eq.high.gain.value=eqHighGain;

    try{ micSource.disconnect(); }catch{}
    micSource.connect(eq.low); eq.low.connect(eq.mid); eq.mid.connect(eq.high);
    eq.high.connect(dryGain); eq.high.connect(delayNode); eq.high.connect(reverbPreDelay); eq.high.connect(flangerDelay);
  } else if (!enable && eq){
    try{ eq.low.disconnect(); eq.mid.disconnect(); eq.high.disconnect(); }catch{}
    try{ micSource.disconnect(); }catch{}
    micSource.connect(dryGain); micSource.connect(delayNode); micSource.connect(reverbPreDelay); micSource.connect(flangerDelay);
    eq=null;
  }
}

function updateDelayFromTempo(){
  if (delaySyncMode !== 'note') return;
  const q = quarterSecForBPM(masterBPM || 120);
  const mult = applyVariant(NOTE_MULT[delayDivision]||0.5, delayVariant);
  delayNode.delayTime.value = clamp(q*mult, 0.001, 2.0);
}

// ======= BEFORE-FX BUTTONS + POPUP =======
const beforeFXBtns = {
  delay:  $('#fxBeforeBtn_delay'),
  reverb: $('#fxBeforeBtn_reverb'),
  flanger:$('#fxBeforeBtn_flanger'),
  eq5:    $('#fxBeforeBtn_eq5'),
  pitch:  $('#fxBeforeBtn_pitch') // live pitch shifting not implemented
};
const fxBeforeParamsPopup = $('#fxBeforeParamsPopup');

function openBeforeFxPopup(tab='reverb'){
  fxBeforeParamsPopup.classList.remove('hidden');
  fxBeforeParamsPopup.innerHTML = `
    <div class="fx-popup-inner">
      <h3>Before FX – ${tab.toUpperCase()}</h3>
      <div id="beforeFxBody">${renderBeforeFxTab(tab)}</div>
      <div style="margin-top:8px;">
        <button id="closeBeforeFx">Close</button>
      </div>
    </div>`;
  $('#closeBeforeFx').addEventListener('click', ()=>fxBeforeParamsPopup.classList.add('hidden'));
  wireBeforeFxTab(tab);
}

function renderBeforeFxTab(tab){
  if (tab==='reverb') return `
    <label>Mix <span id="rvMixVal">${Math.round(reverbMix*100)}%</span>
      <input id="rvMix" type="range" min="0" max="100" value="${Math.round(reverbMix*100)}"></label>
    <label>Room Size <span id="rvRoomVal">${reverbRoomSeconds.toFixed(2)} s</span>
      <input id="rvRoom" type="range" min="0.3" max="6.0" step="0.05" value="${reverbRoomSeconds}"></label>
    <label>Decay <span id="rvDecayVal">${reverbDecay.toFixed(2)}</span>
      <input id="rvDecay" type="range" min="0.5" max="4.0" step="0.05" value="${reverbDecay}"></label>
    <label>Pre-delay <span id="rvPreVal">${reverbPreDelayMs} ms</span>
      <input id="rvPre" type="range" min="0" max="200" step="1" value="${reverbPreDelayMs}"></label>
  `;
  if (tab==='delay') return `
    <label>Mode
      <select id="dlMode"><option value="note" ${delaySyncMode==='note'?'selected':''}>Tempo-sync</option><option value="ms" ${delaySyncMode==='ms'?'selected':''}>Milliseconds</option></select>
    </label>
    <div id="dlNoteRow">
      <label>Division
        <select id="dlDiv">${['1/1','1/2','1/4','1/8','1/16','1/32'].map(x=>`<option ${x===delayDivision?'selected':''}>${x}</option>`).join('')}</select>
      </label>
      <label>Variant
        <select id="dlVar">
          <option value="straight" ${delayVariant==='straight'?'selected':''}>Straight</option>
          <option value="dotted" ${delayVariant==='dotted'?'selected':''}>Dotted</option>
          <option value="triplet" ${delayVariant==='triplet'?'selected':''}>Triplet</option>
        </select>
      </label>
    </div>
    <div id="dlMsRow" style="display:none;">
      <label>Delay Time <span id="dlMsVal">${delayMs} ms</span>
        <input id="dlMs" type="range" min="1" max="2000" value="${delayMs}"></label>
    </div>
    <label>Feedback <span id="dlFbVal">${Math.round(delayFeedbackAmt*100)}%</span>
      <input id="dlFb" type="range" min="0" max="95" value="${Math.round(delayFeedbackAmt*100)}"></label>
    <label>Mix <span id="dlMixVal">${Math.round(delayMix*100)}%</span>
      <input id="dlMix" type="range" min="0" max="100" value="${Math.round(delayMix*100)}"></label>
  `;
  if (tab==='flanger') return `
    <label>Rate <span id="flRateVal">${flangerRateHz.toFixed(2)} Hz</span>
      <input id="flRate" type="range" min="0.05" max="5" step="0.01" value="${flangerRateHz}"></label>
    <label>Depth <span id="flDepthVal">${flangerDepthMs.toFixed(2)} ms</span>
      <input id="flDepth" type="range" min="0" max="5" step="0.01" value="${flangerDepthMs}"></label>
    <label>Feedback <span id="flFbVal">${Math.round(flangerFeedbackAmt*100)}%</span>
      <input id="flFb" type="range" min="-95" max="95" value="${Math.round(flangerFeedbackAmt*100)}"></label>
    <label>Mix <span id="flMixVal">${Math.round(flangerMix*100)}%</span>
      <input id="flMix" type="range" min="0" max="100" value="${Math.round(flangerMix*100)}"></label>
  `;
  if (tab==='eq') return `
    <label>Low Shelf Gain <span id="eqLowVal">${eqLowGain} dB</span>
      <input id="eqLow" type="range" min="-12" max="12" value="${eqLowGain}"></label>
    <label>Mid Gain <span id="eqMidGainVal">${eqMidGain} dB</span>
      <input id="eqMidGain" type="range" min="-12" max="12" value="${eqMidGain}"></label>
    <label>Mid Freq <span id="eqMidFreqVal">${eqMidFreq} Hz</span>
      <input id="eqMidFreq" type="range" min="300" max="5000" step="10" value="${eqMidFreq}"></label>
    <label>Mid Q <span id="eqMidQVal">${eqMidQ.toFixed(2)}</span>
      <input id="eqMidQ" type="range" min="0.3" max="4.0" step="0.01" value="${eqMidQ}"></label>
    <label>High Shelf Gain <span id="eqHighVal">${eqHighGain} dB</span>
      <input id="eqHigh" type="range" min="-12" max="12" value="${eqHighGain}"></label>
  `;
  if (tab==='pitch') return `
    <p style="max-width:32ch;line-height:1.3;">Live input pitch shifting needs advanced DSP (AudioWorklet / phase vocoder). This build doesn’t include it. Use per-track <b>After-FX → Pitch (PlaybackRate)</b> for ±12 semitones on loops.</p>
  `;
  return '';
}

function wireBeforeFxTab(tab){
  if (tab==='reverb'){
    $('#rvMix').addEventListener('input', e=>{ reverbMix = parseFloat(e.target.value)/100; reverbWet.gain.value = beforeState.reverb ? reverbMix : 0; $('#rvMixVal').textContent = Math.round(reverbMix*100)+'%'; });
    const regen = debounce(()=>{ convolver.buffer = makeReverbImpulse(reverbRoomSeconds, reverbDecay); }, 180);
    $('#rvRoom').addEventListener('input', e=>{ reverbRoomSeconds = parseFloat(e.target.value); $('#rvRoomVal').textContent = reverbRoomSeconds.toFixed(2)+' s'; regen(); });
    $('#rvDecay').addEventListener('input', e=>{ reverbDecay = parseFloat(e.target.value); $('#rvDecayVal').textContent = reverbDecay.toFixed(2); regen(); });
    $('#rvPre').addEventListener('input', e=>{ reverbPreDelayMs = parseInt(e.target.value,10); reverbPreDelay.delayTime.value = reverbPreDelayMs/1000; $('#rvPreVal').textContent = reverbPreDelayMs+' ms'; });
  }
  if (tab==='delay'){
    const syncUI = ()=>{ const noteRow=$('#dlNoteRow'), msRow=$('#dlMsRow'); if (delaySyncMode==='note'){ noteRow.style.display='block'; msRow.style.display='none'; updateDelayFromTempo(); } else { noteRow.style.display='none'; msRow.style.display='block'; delayNode.delayTime.value = clamp(delayMs/1000,0,2);} };
    $('#dlMode').addEventListener('change', e=>{ delaySyncMode = e.target.value; syncUI(); });
    $('#dlDiv').addEventListener('change', e=>{ delayDivision = e.target.value; updateDelayFromTempo(); });
    $('#dlVar').addEventListener('change', e=>{ delayVariant = e.target.value; updateDelayFromTempo(); });
    $('#dlMs').addEventListener('input', e=>{ delayMs = parseInt(e.target.value,10); if (delaySyncMode==='ms') delayNode.delayTime.value = clamp(delayMs/1000,0,2); $('#dlMsVal').textContent = delayMs+' ms'; });
    $('#dlFb').addEventListener('input', e=>{ delayFeedbackAmt = parseFloat(e.target.value)/100; delayFeedback.gain.value = clamp(delayFeedbackAmt,0,0.95); $('#dlFbVal').textContent = Math.round(delayFeedbackAmt*100)+'%'; });
    $('#dlMix').addEventListener('input', e=>{ delayMix = parseFloat(e.target.value)/100; delayWet.gain.value = beforeState.delay ? delayMix : 0; $('#dlMixVal').textContent = Math.round(delayMix*100)+'%'; });
    syncUI();
  }
  if (tab==='flanger'){
    $('#flRate').addEventListener('input', e=>{ flangerRateHz = parseFloat(e.target.value); flangerLFO.frequency.value = flangerRateHz; $('#flRateVal').textContent = flangerRateHz.toFixed(2)+' Hz'; });
    $('#flDepth').addEventListener('input', e=>{ flangerDepthMs = parseFloat(e.target.value); flangerDepthGain.gain.value = flangerDepthMs/1000; $('#flDepthVal').textContent = flangerDepthMs.toFixed(2)+' ms'; });
    $('#flFb').addEventListener('input', e=>{ flangerFeedbackAmt = parseFloat(e.target.value)/100; flangerFeedback.gain.value = clamp(flangerFeedbackAmt, -0.95, 0.95); $('#flFbVal').textContent = Math.round(flangerFeedbackAmt*100)+'%'; });
    $('#flMix').addEventListener('input', e=>{ flangerMix = parseFloat(e.target.value)/100; flangerWet.gain.value = beforeState.flanger ? flangerMix : 0; $('#flMixVal').textContent = Math.round(flangerMix*100)+'%'; });
  }
  if (tab==='eq'){
    $('#eqLow').addEventListener('input', e=>{ eqLowGain=parseInt(e.target.value,10); if(eq?.low) eq.low.gain.value=eqLowGain; $('#eqLowVal').textContent = eqLowGain+' dB'; });
    $('#eqMidGain').addEventListener('input', e=>{ eqMidGain=parseInt(e.target.value,10); if(eq?.mid) eq.mid.gain.value=eqMidGain; $('#eqMidGainVal').textContent = eqMidGain+' dB'; });
    $('#eqMidFreq').addEventListener('input', e=>{ eqMidFreq=parseInt(e.target.value,10); if(eq?.mid) eq.mid.frequency.value=eqMidFreq; $('#eqMidFreqVal').textContent = eqMidFreq+' Hz'; });
    $('#eqMidQ').addEventListener('input', e=>{ eqMidQ=parseFloat(e.target.value); if(eq?.mid) eq.mid.Q.value=eqMidQ; $('#eqMidQVal').textContent = eqMidQ.toFixed(2); });
    $('#eqHigh').addEventListener('input', e=>{ eqHighGain=parseInt(e.target.value,10); if(eq?.high) eq.high.gain.value=eqHighGain; $('#eqHighVal').textContent = eqHighGain+' dB'; });
  }
}

function wireBeforeFX(){
  // Toggle and open popup to tweak
  if (beforeFXBtns.reverb){
    addTap(beforeFXBtns.reverb, async ()=>{
      await ensureMic();
      beforeState.reverb = !beforeState.reverb;
      beforeFXBtns.reverb.classList.toggle('active', beforeState.reverb);
      reverbWet.gain.value = beforeState.reverb ? reverbMix : 0;
      openBeforeFxPopup('reverb');
    });
  }
  if (beforeFXBtns.delay){
    addTap(beforeFXBtns.delay, async ()=>{
      await ensureMic();
      beforeState.delay = !beforeState.delay;
      beforeFXBtns.delay.classList.toggle('active', beforeState.delay);
      delayWet.gain.value = beforeState.delay ? delayMix : 0;
      openBeforeFxPopup('delay');
    });
  }
  if (beforeFXBtns.flanger){
    addTap(beforeFXBtns.flanger, async ()=>{
      await ensureMic();
      beforeState.flanger = !beforeState.flanger;
      beforeFXBtns.flanger.classList.toggle('active', beforeState.flanger);
      flangerWet.gain.value = beforeState.flanger ? flangerMix : 0;
      openBeforeFxPopup('flanger');
    });
  }
  if (beforeFXBtns.eq5){
    addTap(beforeFXBtns.eq5, async ()=>{
      await ensureMic();
      beforeState.eq5 = !beforeState.eq5;
      beforeFXBtns.eq5.classList.toggle('active', beforeState.eq5);
      toggleEQ(beforeState.eq5);
      openBeforeFxPopup('eq');
    });
  }
  if (beforeFXBtns.pitch){
    addTap(beforeFXBtns.pitch, ()=> openBeforeFxPopup('pitch'));
  }
}

// ======= LOOPER (core) =======
class Looper {
  constructor(index, recordKey, stopKey){
    this.index = index;
    this.mainBtn = $('#mainLooperBtn'+index);
    this.stopBtn = $('#stopBtn'+index);
    this.looperIcon = $('#looperIcon'+index);
    this.ledRing = $('#progressBar'+index);
    this.stateDisplay = $('#stateDisplay'+index);
    this.recordKey = recordKey; this.stopKey = stopKey;
    this.state = 'ready';
    this.mediaRecorder = null; this.chunks = [];
    this.loopBuffer = null; this.sourceNode = null;
    this.loopStartTime = 0; this.loopDuration = 0;
    this.overdubChunks = []; this.holdTimer = null;
    this.divider = 1; this.uiDisabled = false;

    // Overdub tuning parameters (editable)
    this.prerecordMs = null;        // will be set on arm using BPM heuristic
    this.manualNudgeMs = -20;      // negative = shift overdub earlier (ms). Tweak per machine
    this.overdubGain = 1.0;        // scale overdub when mixing
    this.overdubStartAudioTime = null; // will be set when overdub actually starts
    this.useWorkletRecording = true; // use LooperRecorder (recorder.js) when available

    // Track output gain
    this.gainNode = audioCtx.createGain();
    const volSlider = $('#volSlider'+index), volValue = $('#volValue'+index);
    this.gainNode.gain.value = 0.9;
    if (volSlider && volValue){
      volSlider.value = 90; volValue.textContent = '90%';
      volSlider.addEventListener('input', ()=>{ const v=parseInt(volSlider.value,10); this.gainNode.gain.value=v/100; volValue.textContent=v+'%'; });
    }

    // ===== After-FX chain state =====
  this.pitchSemitones = 0;                    // “Pitch (PlaybackRate)” effect uses this
  this.fx = { chain: [], nextId: 1 };         // array of {id,type,name,params,bypass,nodes}

  this.updateUI();
  this.setRing(0);

  if (index>=2 && dividerSelectors[index]){
    this.divider = parseFloat(dividerSelectors[index].value);
    dividerSelectors[index].addEventListener('change', e=>{
      this.divider=parseFloat(e.target.value);
    });
    this.disable(true);
  }

  addHold(this.stopBtn,
    ()=>{
      if (this.state==='ready') return;
      this.holdTimer=setTimeout(()=>{
        this.clearLoop();
        this.holdTimer=null;
      },2000);
    },
    ()=>{
      if (this.holdTimer){
        clearTimeout(this.holdTimer);
        this.holdTimer=null;
        if (this.state==='playing'||this.state==='overdub' || this.state ==='prerecord') this.stopPlayback();
        else if (this.state==='stopped') this.resumePlayback();
        else if (this.state==='recording') this.abortRecording();
      }
    }
  );

  addTap(this.mainBtn, async ()=>{
    await ensureMic();
    await this.handleMainBtn();
  });

  const fxBtn = $('#fxMenuBtn'+index);
  if (fxBtn) fxBtn.addEventListener('click', ()=> openTrackFxMenu(this.index));
}

setLED(color){
    const map={green:'#22c55e', red:'#e11d48', orange:'#f59e0b', gray:'#6b7280', yellow:'#fde047', blue:'#3b82f6'};
    this.ledRing.style.stroke=map[color]||'#fff';
    this.ledRing.style.filter=(color==='gray' ? 'none' : 'drop-shadow(0 0 8px '+(map[color]+'88')+')');
}

setRing(r){
  const R=42,C=2*Math.PI*R;
  this.ledRing.style.strokeDasharray=C;
  this.ledRing.style.strokeDashoffset=C*(1-r);
}

setIcon(s,c){
  this.looperIcon.textContent=s;
  if(c) this.looperIcon.style.color=c;
}

setDisplay(t){
  this.stateDisplay.textContent=t;
}

updateUI(){
  switch(this.state){
    case 'ready': this.setLED('green'); this.setRing(0); this.setIcon('▶'); this.setDisplay('Ready'); break;
    case 'recording': this.setLED('yellow'); this.setIcon('⦿','#e11d48'); this.setDisplay('Recording...'); break;
    case 'playing': this.setLED('green'); this.setIcon('▶'); this.setDisplay('Playing'); break;
    case 'prerecord': this.setLED('blue'); this.setIcon('⦿','#3b82f6'); this.setDisplay('Preroll...'); break;
    case 'overdub': this.setLED('yellow'); this.setIcon('⦿','#f59e0b'); this.setDisplay('Overdubbing'); break;
    case 'stopped': this.setLED('gray'); this.setRing(0); this.setIcon('▶','#aaa'); this.setDisplay('Stopped'); break;
    case 'waiting': this.setLED('gray'); this.setRing(0); this.setIcon('⏳','#aaa'); this.setDisplay('Waiting...'); break;
  }
  if (this.uiDisabled){
    this.mainBtn.disabled=true;
    this.stopBtn.disabled=true;
    this.mainBtn.classList.add('disabled-btn');
    this.stopBtn.classList.add('disabled-btn');
    this.setDisplay('WAIT: Set Track 1');
  } else {
    this.mainBtn.disabled=false;
    this.stopBtn.disabled=false;
    this.mainBtn.classList.remove('disabled-btn');
    this.stopBtn.classList.remove('disabled-btn');
  }
}

disable(v){
  this.uiDisabled=v;
  this.updateUI();
}

async handleMainBtn(){
  if (this.state==='ready') await this.phaseLockedRecord();
  else if (this.state==='recording') await this.stopRecordingAndPlay();
  else if (this.state==='playing') this.armOverdub();
  else if (this.state==='overdub' || this.state === 'prerecord') this.finishOverdub();
}

async phaseLockedRecord(){
  if (!processedStream) await ensureMic();
  if (this.index===1 || !masterIsSet){
    await this.startRecording();
    return;
  }
  this.state='waiting';
  this.updateUI();
  const now = audioCtx.currentTime, master = loopers[1];
  const elapsed = (now - master.loopStartTime) % masterLoopDuration;
  const toNext = masterLoopDuration - elapsed;
  setTimeout(()=>{
    this._startPhaseLockedRecording(masterLoopDuration*this.divider);
  }, toNext*1000);
}

async _startPhaseLockedRecording(len){
  this.state='recording';
  this.updateUI();
  this.chunks=[];
  this.mediaRecorder=new MediaRecorder(processedStream);
  this.mediaRecorder.ondataavailable = e=>{ if (e.data.size>0) this.chunks.push(e.data); };
  this.mediaRecorder.start();
  const start=Date.now(), self=this;
  (function anim(){
    if (self.state==='recording'){
      const pct=(Date.now()-start)/(len*1000);
      self.setRing(Math.min(pct,1));
      if (pct<1) requestAnimationFrame(anim);
      if (pct>=1) self.stopRecordingAndPlay();
    }
  })();
  setTimeout(()=>{
    if (this.state==='recording') self.stopRecordingAndPlay();
  }, len*1000);
}

async startRecording(){
  if (!processedStream) await ensureMic();
  if (this.index>=2 && !masterIsSet) return;
  this.state='recording';
  this.updateUI();
  this.chunks=[];
  this.mediaRecorder=new MediaRecorder(processedStream);
  this.mediaRecorder.ondataavailable = e=>{ if (e.data.size>0) this.chunks.push(e.data); };
  this.mediaRecorder.start();
  const start=Date.now(), self=this;
  const max=(this.index===1)
    ?60000
    :(masterLoopDuration? masterLoopDuration*this.divider*1000 : 12000);
  (function anim(){
    if (self.state==='recording'){
      const pct=(Date.now()-start)/max;
      self.setRing(Math.min(pct,1));
      if (pct<1) requestAnimationFrame(anim);
      if (pct>=1) self.stopRecordingAndPlay();
    }
  })();
}

async stopRecordingAndPlay(){
  if (!this.mediaRecorder) return;
  this.state='playing';
  this.updateUI();
  this.mediaRecorder.onstop = async ()=>{
    const blob=new Blob(this.chunks,{type:'audio/webm'});
    const buf=await blob.arrayBuffer();
    audioCtx.decodeAudioData(buf, buffer=>{
      this.loopBuffer=buffer;
      this.loopDuration=buffer.duration;
      if (this.index===1){
        masterLoopDuration=this.loopDuration;
        masterBPM = Math.round((60/this.loopDuration)*4);
        updateDelayFromTempo(); // 🔔 sync delay with new BPM
        masterIsSet=true;
        bpmLabel.textContent = `BPM: ${masterBPM}`;
        for (let k=2;k<=4;k++) loopers[k].disable(false);
      }
      this.startPlayback();
    });
  };
  this.mediaRecorder.stop();
}

abortRecording(){
  if (this.mediaRecorder && this.state==='recording'){
    try{
      this.mediaRecorder.ondataavailable=null;
      this.mediaRecorder.stop();
    }catch{}
    this.mediaRecorder=null;
    this.chunks=[];
    this.state='ready';
    this.loopBuffer=null;
    this.loopDuration=0;
    this.setRing(0);
    this.updateUI();
  }
}

// ===== After-FX CHAIN WIRING =====
  _disconnectChain(){
    // Disconnect old chain safely
    try{ this.gainNode.disconnect(); }catch{}
  }
  _applyPitchIfAny(){
    const fxPitch = this.fx.chain.find(e=>e.type==='Pitch');
    const semis = fxPitch ? fxPitch.params.semitones : this.pitchSemitones;
    const rate = Math.pow(2, (semis||0)/12);
    if (this.sourceNode) this.sourceNode.playbackRate.setValueAtTime(rate, audioCtx.currentTime);
  }
  _buildEffectNodes(effect){
    // Destroy previous nodes
    if (effect.nodes?.dispose){ try{ effect.nodes.dispose(); }catch{} }
    // Create per type
    if (effect.type==='LowPass'){
      const input = audioCtx.createGain(), biq = audioCtx.createBiquadFilter(), output = audioCtx.createGain();
      biq.type='lowpass';
      input.connect(biq); biq.connect(output);
      biq.frequency.value = effect.params.cutoff; biq.Q.value = effect.params.q;
      effect.nodes = { input, output, biq, dispose(){ try{input.disconnect(); biq.disconnect(); output.disconnect();}catch{} } };
      return;
    }
    if (effect.type==='HighPass'){
      const input = audioCtx.createGain(), biq = audioCtx.createBiquadFilter(), output = audioCtx.createGain();
      biq.type='highpass';
      input.connect(biq); biq.connect(output);
      biq.frequency.value = effect.params.cutoff; biq.Q.value = effect.params.q;
      effect.nodes = { input, output, biq, dispose(){ try{input.disconnect(); biq.disconnect(); output.disconnect();}catch{} } };
      return;
    }
    if (effect.type==='Pan'){
      const input = audioCtx.createGain(), output = audioCtx.createGain();
      const panner = (typeof audioCtx.createStereoPanner==='function') ? audioCtx.createStereoPanner() : null;
      if (panner){ input.connect(panner); panner.connect(output); panner.pan.value = effect.params.pan; }
      else { input.connect(output); }
      effect.nodes = { input, output, panner, dispose(){ try{input.disconnect(); panner?.disconnect(); output.disconnect();}catch{} } };
      return;
    }
    if (effect.type==='Delay'){
      // Insert-style delay with internal dry/wet
      const input = audioCtx.createGain(), output = audioCtx.createGain();
      const dry = audioCtx.createGain(), wet = audioCtx.createGain(), d = audioCtx.createDelay(2.0), fb = audioCtx.createGain();
      input.connect(dry); dry.connect(output);
      input.connect(d); d.connect(wet); wet.connect(output);
      d.connect(fb); fb.connect(d);
      d.delayTime.value = effect.params.timeSec;
      fb.gain.value = clamp(effect.params.feedback, 0, 0.95);
      wet.gain.value = clamp(effect.params.mix, 0, 1);
      effect.nodes = { input, output, dry, wet, d, fb, dispose(){ try{input.disconnect(); dry.disconnect(); wet.disconnect(); d.disconnect(); fb.disconnect(); output.disconnect();}catch{} } };
      return;
    }
    if (effect.type==='Compressor'){
      const input = audioCtx.createGain(), comp = audioCtx.createDynamicsCompressor(), output = audioCtx.createGain();
      input.connect(comp); comp.connect(output);
      comp.threshold.value = effect.params.threshold;
      comp.knee.value      = effect.params.knee;
      comp.ratio.value     = effect.params.ratio;
      comp.attack.value    = effect.params.attack;
      comp.release.value   = effect.params.release;
      effect.nodes = { input, output, comp, dispose(){ try{input.disconnect(); comp.disconnect(); output.disconnect();}catch{} } };
      return;
    }
    if (effect.type==='Pitch'){
      // no nodes; handled via playbackRate on the source
      effect.nodes = { input:null, output:null, dispose(){} };
      return;
    }
  }
  _rebuildChainWiring(){
    if (!this.sourceNode) return;
    // Disconnect source/gain previous
    try{ this.sourceNode.disconnect(); }catch{}
    try{ this.gainNode.disconnect(); }catch{}
    // apply pitch first (property)
    this._applyPitchIfAny();

    // connect series nodes
    let head = this.sourceNode;
    for (const fx of this.fx.chain){
      if (fx.type==='Pitch') continue;
      this._buildEffectNodes(fx);
      if (fx.bypass){
        // Bypass = straight wire through
        // (still create nodes so “Edit” works; but connect head directly)
        continue;
      }
    }
    // Now wire respecting bypass/ordering
    for (const fx of this.fx.chain){
      if (fx.type==='Pitch') continue;
      const nodes = fx.nodes;
      if (!nodes) continue;
      // If bypass: do nothing (skip), else wire head -> fx.input -> fx.output
      if (!fx.bypass){
        try{ head.connect(nodes.input); }catch{}
        head = nodes.output;
      }
    }
    // into track gain, then to speakers
    try{ head.connect(this.gainNode); }catch{}
    this.gainNode.connect(audioCtx.destination);
  }

  startPlayback(){
    if (!this.loopBuffer) return;
    if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} }
    this.sourceNode = audioCtx.createBufferSource();
    this.sourceNode.buffer = this.loopBuffer; this.sourceNode.loop = true;

    // Sync offset vs master
    let off=0;
    if (this.index!==1 && masterIsSet && loopers[1].sourceNode && masterLoopDuration>0){
      const master = loopers[1]; const now = audioCtx.currentTime - master.loopStartTime;
      off = now % masterLoopDuration; if (isNaN(off)||off<0||off>this.loopBuffer.duration) off=0;
    }
    this.loopStartTime = audioCtx.currentTime - off;

    // Build After-FX chain
    this._rebuildChainWiring();

    try{ this.sourceNode.start(0, off); }catch{ try{ this.sourceNode.start(0,0); }catch{} }

    this.state='playing'; this.updateUI(); this._animate();
    renderTrackFxSummary(this.index); // update labels
  }
  resumePlayback(){
    if (this.index===1){
      this.startPlayback();
      for (let k=2;k<=4;k++) if (loopers[k].state==='playing') loopers[k].startPlayback();
    } else { this.startPlayback(); }
  }
  stopPlayback(){ if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} } this.state='stopped'; this.updateUI(); }

  armOverdub(){
    if (this.state!=='playing') return;

    // set prerecord state and visual
    this.state = 'prerecord';
    this.updateUI();

    // determine prerecordMs heuristic: at least 150ms or 1/16 note at BPM
    const bpm = masterBPM || 120;
    const sixteenthMs = (60 / bpm) / 4 * 1000;
    this.prerecordMs = Math.max(150, Math.round(sixteenthMs));

    // start low-latency buffering (worklet)
    if (window._globalLooperRecorder && this.useWorkletRecording) {
      try {
        window._globalLooperRecorder.start();
      } catch (e) {
        console.warn('recorder start failed', e);
      }
    }

    // schedule phase-locked start (use outputLatency compensation below in same way as before)
    const now = audioCtx.currentTime;
    const elapsed = (now - this.loopStartTime) % this.loopDuration;
    const outputLatency = (typeof audioCtx.outputLatency === 'number') ? audioCtx.outputLatency : (audioCtx.baseLatency || 0.040);
    let timeToNextLoop = (this.loopDuration - elapsed) - outputLatency;
    if (timeToNextLoop < 0) timeToNextLoop += this.loopDuration;

    setTimeout(()=> this.startOverdubRecording(), timeToNextLoop * 1000);
  }

  startOverdubRecording(){
    // If using worklet recorder:
    if (window._globalLooperRecorder && this.useWorkletRecording){
      // mark the exact sample position boundary in the worklet
      try{
        // markStart stores sample count inside the worklet; main thread will use audioCtx.currentTime for reference
        window._globalLooperRecorder.markStart();
      }catch(err){ console.warn('markStart failed', err); }

      // record the audioCtx time when overdub *actually* starts — used to compute placement
      this.overdubStartAudioTime = audioCtx.currentTime;

      // update UI to show active recording
      this.state='overdub';
      this.updateUI();

      // schedule stop after one loopDuration seconds
      setTimeout(()=> {
        if(this.state !== 'overdub') return; // Avoid stopping if already stopped
        try { window._globalLooperRecorder.stop(); } catch(e){ console.warn('recorder.stop failed', e); }
        // The ondata callback (see next section) will handle mixing/finish
      }, Math.round(this.loopDuration * 1000));
      return;
    }

    // Fallback: previous MediaRecorder path (kept for compatibility)
    this.overdubChunks=[]; this.mediaRecorder=new MediaRecorder(processedStream);
    this.mediaRecorder.ondataavailable = e=>{ if (e.data.size>0) this.overdubChunks.push(e.data); };
    this.mediaRecorder.start();
    setTimeout(()=>this.finishOverdub(), this.loopDuration*1000);
  }

  finishOverdub(){
    if (this.useWorkletRecording && window._globalLooperRecorder) {
      if(this.state === 'overdub'){
         try { window._globalLooperRecorder.stop(); } catch(e){ console.warn('recorder.stop failed on manual finish', e); }
      }
      // worklet stop already triggers ondata -> mixing; just update state
      this.state='playing';
      this.updateUI();
      return;
    }

    // Fallback old MediaRecorder path (keep original behavior if no worklet)
    if (this.mediaRecorder && this.mediaRecorder.state==='recording'){
      this.mediaRecorder.onstop = async ()=>{
        const od=new Blob(this.overdubChunks,{type:'audio/webm'}), arr=await od.arrayBuffer();
        audioCtx.decodeAudioData(arr, newBuf=>{
          const oC=this.loopBuffer.numberOfChannels, nC=newBuf.numberOfChannels;
          const outC=Math.max(oC,nC), length=Math.max(this.loopBuffer.length,newBuf.length);
          const out=audioCtx.createBuffer(outC, length, this.loopBuffer.sampleRate);
          for (let ch=0; ch<outC; ch++){
            const outD=out.getChannelData(ch), o=oC>ch?this.loopBuffer.getChannelData(ch):null, n=nC>ch?newBuf.getChannelData(ch):null;
            for (let i=0;i<length;i++) outD[i]=(o?o[i]||0:0)+(n?n[i]||0:0);
          }
          this.loopBuffer=out; this.loopDuration=out.duration; this.startPlayback();
        });
      };
      this.mediaRecorder.stop();
    } else { this.state='playing'; this.updateUI(); }
  }

  clearLoop(){
    if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} }
    this.loopBuffer=null; this.loopDuration=0; this.state='ready'; this.updateUI();
    if (this.index===1){
      masterLoopDuration=null; masterBPM=null; masterIsSet=false; bpmLabel.textContent='BPM: --';
      for (let k=2;k<=4;k++) loopers[k].disable(true);
      for (let k=2;k<=4;k++) loopers[k].clearLoop();
      updateDelayFromTempo();
    }
  }
  _animate(){
    if ((this.state==='playing' || this.state==='overdub' || this.state === 'prerecord') && this.loopDuration>0 && this.sourceNode){
      const now = audioCtx.currentTime; const pos=(now - this.loopStartTime)%this.loopDuration;
      this.setRing(pos/this.loopDuration); requestAnimationFrame(this._animate.bind(this));
    } else { this.setRing(0); }
  }
}

// ======= BUILD LOOPERS + KEYBINDS =======
const keyMap = [
  {rec:'w',stop:'s'},
  {rec:'e',stop:'d'},
  {rec:'r',stop:'f'},
  {rec:'t',stop:'g'}
];

window.loopers = [];
for (let i=1; i<=4; i++) {
  loopers[i] = new Looper(i, keyMap[i-1].rec, keyMap[i-1].stop);
}

document.addEventListener('keydown', e=>{
  // 🔐 Block hotkeys until login
  if (!isAuthed) return;

  const k = e.key.toLowerCase();
  loopers.forEach((lp, idx)=>{
    if (idx === 0) return;
    if (k === keyMap[idx-1].rec) {
      lp.mainBtn.click();
      e.preventDefault();
    }
    if (k === keyMap[idx-1].stop) {
      if (lp.state === 'playing' || lp.state === 'overdub' || lp.state === 'prerecord') lp.stopPlayback();
      else if (lp.state === 'stopped') lp.resumePlayback();
      else if (lp.state === 'recording') lp.abortRecording();
      e.preventDefault();
    }
  });
});

// ======= AFTER-FX: MENU + PARAM POPUPS + REORDER =======
const fxMenuPopup   = $('#fxMenuPopup');
const fxParamsPopup = $('#fxParamsPopup');

// Catalog of available after-fx
const AFTER_FX_CATALOG = [
  { type:'Pitch',      name:'Pitch (PlaybackRate)', defaults:{ semitones:0 } },
  { type:'LowPass',    name:'Low-pass Filter',      defaults:{ cutoff:12000, q:0.7 } },
  { type:'HighPass',   name:'High-pass Filter',     defaults:{ cutoff:120, q:0.7 } },
  { type:'Pan',        name:'Pan',                  defaults:{ pan:0 } },
  { type:'Delay',      name:'Delay (Insert)',       defaults:{ timeSec:0.25, feedback:0.25, mix:0.25 } },
  { type:'Compressor', name:'Compressor',           defaults:{ threshold:-18, knee:6, ratio:3, attack:0.003, release:0.25 } },
];

function addEffectToTrack(lp, type){
  const meta = AFTER_FX_CATALOG.find(x=>x.type===type);
  if (!meta) return;
  const eff = { id: lp.fx.nextId++, type, name: meta.name, params: {...meta.defaults}, bypass:false, nodes:null };
  // If adding Pitch: bind to lp.pitchSemitones value
  if (type==='Pitch') eff.params.semitones = lp.pitchSemitones || 0;
  lp.fx.chain.push(eff);
  if (lp.state==='playing') lp._rebuildChainWiring();
  renderTrackFxSummary(lp.index);
}

function moveEffect(lp, id, dir){
  const i = lp.fx.chain.findIndex(e=>e.id===id); if (i<0) return;
  const j = i + (dir==='up'?-1:+1);
  if (j<0 || j>=lp.fx.chain.length) return;
  const [x] = lp.fx.chain.splice(i,1);
  lp.fx.chain.splice(j,0,x);
  if (lp.state==='playing') lp._rebuildChainWiring();
  openTrackFxMenu(lp.index); // refresh list
}

function removeEffect(lp, id){
  const i = lp.fx.chain.findIndex(e=>e.id===id); if (i<0) return;
  const [ fx ] = lp.fx.chain.splice(i,1);
  try{ fx.nodes?.dispose?.(); }catch{}
  if (fx.type==='Pitch') lp.pitchSemitones = 0;
  if (lp.state==='playing') lp._rebuildChainWiring();
  openTrackFxMenu(lp.index);
}

function toggleBypass(lp, id){
  const fx = lp.fx.chain.find(e=>e.id===id); if (!fx) return;
  fx.bypass = !fx.bypass;
  if (lp.state==='playing') lp._rebuildChainWiring();
  openTrackFxMenu(lp.index);
}

function renderTrackFxSummary(idx){
  const lp = loopers[idx]; const el = $('#trackFxLabels'+idx); if (!lp || !el) return;
  if (!lp.fx.chain.length){ el.textContent=''; return; }
  el.textContent = lp.fx.chain.map((e,i)=> `${i+1}.${e.type === 'Pitch' ? `Pitch ${e.params.semitones>0?'+':''}${e.params.semitones}` : e.name}`).join(' → ');
}

function openTrackFxMenu(idx){
  const lp = loopers[idx]; if (!lp) return;
  fxMenuPopup.classList.remove('hidden');
  fxMenuPopup.innerHTML = `
    <div class="fx-popup-inner">
      <h3>Track ${idx} – After FX</h3>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
        ${AFTER_FX_CATALOG.map(m=>`<button class="addFxBtn" data-type="${m.type}">+ ${m.name}</button>`).join('')}
      </div>
      <div><strong>Chain (series order):</strong></div>
      <div id="chainList" style="margin-top:8px;">
        ${lp.fx.chain.length? lp.fx.chain.map((e,i)=>`
          <div class="fx-row" style="display:flex;align-items:center;gap:8px;margin:8px 0;">
            <div style="width:28px;text-align:right;">${i+1}</div>
            <div style="flex:1">${e.name}${e.type==='Pitch' ? ` — ${e.params.semitones>0?'+':''}${e.params.semitones} st` : ''}</div>
            <button class="upBtn" data-id="${e.id}">▲</button>
            <button class="downBtn" data-id="${e.id}">▼</button>
            <button class="editBtn" data-id="${e.id}">Edit</button>
            <button class="bypassBtn ${e.bypass?'active':''}" data-id="${e.id}">${e.bypass?'Bypassed':'Bypass'}</button>
            <button class="removeBtn" data-id="${e.id}">✖</button>
          </div>`).join('') : `<div class="small" style="margin:6px 0 0 0;">No effects yet. Add from above.</div>`}
      </div>
      <div style="margin-top:10px;">
        <button id="closeFxMenu">Close</button>
      </div>
    </div>`;
  fxMenuPopup.querySelectorAll('.addFxBtn').forEach(b=> b.addEventListener('click', ()=>{ addEffectToTrack(lp, b.dataset.type); openTrackFxMenu(idx); }));
  fxMenuPopup.querySelectorAll('.upBtn').forEach(b=> b.addEventListener('click', ()=> moveEffect(lp, parseInt(b.dataset.id,10), 'up')));
  fxMenuPopup.querySelectorAll('.downBtn').forEach(b=> b.addEventListener('click', ()=> moveEffect(lp, parseInt(b.dataset.id,10), 'down')));
  fxMenuPopup.querySelectorAll('.removeBtn').forEach(b=> b.addEventListener('click', ()=> removeEffect(lp, parseInt(b.dataset.id,10))));
  fxMenuPopup.querySelectorAll('.bypassBtn').forEach(b=> b.addEventListener('click', ()=> toggleBypass(lp, parseInt(b.dataset.id,10))));
  fxMenuPopup.querySelectorAll('.editBtn').forEach(b=> b.addEventListener('click', ()=> openFxParamsPopup(lp.index, parseInt(b.dataset.id,10))));
  $('#closeFxMenu').addEventListener('click', ()=> fxMenuPopup.classList.add('hidden'));
  renderTrackFxSummary(idx);
}

function openFxParamsPopup(idx, id){
  const lp = loopers[idx]; if (!lp) return;
  const fx = lp.fx.chain.find(e=>e.id===id); if (!fx) return;
  fxParamsPopup.classList.remove('hidden');
  fxParamsPopup.innerHTML = `
    <div class="fx-popup-inner">
      <h3>${fx.name} – Parameters</h3>
      <div id="fxParamsBody">${renderFxParamsBody(fx)}</div>
      <div style="margin-top:10px;">
        <button id="closeFxParams">Close</button>
      </div>
    </div>`;
  wireFxParams(lp, fx);
  $('#closeFxParams').addEventListener('click', ()=> fxParamsPopup.classList.add('hidden'));
}

function renderFxParamsBody(fx){
  switch(fx.type){
    case 'Pitch':
      return `
        <label>Semi-tones <span id="pSemVal">${fx.params.semitones}</span>
          <input id="pSem" type="range" min="-12" max="12" step="1" value="${fx.params.semitones}">
        </label>`;
    case 'LowPass':
      return `
        <label>Cutoff <span id="lpCutVal">${Math.round(fx.params.cutoff)} Hz</span>
          <input id="lpCut" type="range" min="200" max="12000" step="10" value="${fx.params.cutoff}">
        </label>
        <label>Q <span id="lpQVal">${fx.params.q.toFixed(2)}</span>
          <input id="lpQ" type="range" min="0.3" max="12" step="0.01" value="${fx.params.q}">
        </label>`;
    case 'HighPass':
      return `
        <label>Cutoff <span id="hpCutVal">${Math.round(fx.params.cutoff)} Hz</span>
          <input id="hpCut" type="range" min="20" max="2000" step="5" value="${fx.params.cutoff}">
        </label>
        <label>Q <span id="hpQVal">${fx.params.q.toFixed(2)}</span>
          <input id="hpQ" type="range" min="0.3" max="12" step="0.01" value="${fx.params.q}">
        </label>`;
    case 'Pan':
      return `
        <label>Pan <span id="panVal">${fx.params.pan.toFixed(2)}</span>
          <input id="pan" type="range" min="-1" max="1" step="0.01" value="${fx.params.pan}">
        </label>`;
    case 'Delay':
      return `
        <label>Time <span id="dTimeVal">${(fx.params.timeSec*1000)|0} ms</span>
          <input id="dTime" type="range" min="1" max="2000" step="1" value="${(fx.params.timeSec*1000)|0}">
        </label>
        <label>Feedback <span id="dFbVal">${Math.round(fx.params.feedback*100)}%</span>
          <input id="dFb" type="range" min="0" max="95" step="1" value="${Math.round(fx.params.feedback*100)}">
        </label>
        <label>Mix <span id="dMixVal">${Math.round(fx.params.mix*100)}%</span>
          <input id="dMix" type="range" min="0" max="100" step="1" value="${Math.round(fx.params.mix*100)}">
        </label>`;
    case 'Compressor':
      return `
        <label>Threshold <span id="cThVal">${fx.params.threshold} dB</span>
          <input id="cTh" type="range" min="-60" max="0" step="1" value="${fx.params.threshold}">
        </label>
        <label>Ratio <span id="cRaVal">${fx.params.ratio}:1</span>
          <input id="cRa" type="range" min="1" max="20" step="0.1" value="${fx.params.ratio}">
        </label>
        <label>Knee <span id="cKnVal">${fx.params.knee} dB</span>
          <input id="cKn" type="range" min="0" max="40" step="1" value="${fx.params.knee}">
        </label>
        <label>Attack <span id="cAtVal">${(fx.params.attack*1000).toFixed(1)} ms</span>
          <input id="cAt" type="range" min="0" max="100" step="0.5" value="${(fx.params.attack*1000).toFixed(1)}">
        </label>
        <label>Release <span id="cRlVal">${(fx.params.release*1000).toFixed(0)} ms</span>
          <input id="cRl" type="range" min="10" max="2000" step="10" value="${(fx.params.release*1000).toFixed(0)}">
        </label>`;
  }
  return `<div class="small">No params.</div>`;
}

function wireFxParams(lp, fx){
  if (fx.type==='Pitch'){
    $('#pSem').addEventListener('input', e=>{
      fx.params.semitones = parseInt(e.target.value,10); $('#pSemVal').textContent = fx.params.semitones;
      lp.pitchSemitones = fx.params.semitones;
      if (lp.state==='playing') lp._applyPitchIfAny();
      renderTrackFxSummary(lp.index);
    });
    return;
  }
  if (fx.type==='LowPass'){
    $('#lpCut').addEventListener('input', e=>{
      fx.params.cutoff = parseFloat(e.target.value); $('#lpCutVal').textContent = Math.round(fx.params.cutoff)+' Hz';
      if (fx.nodes?.biq) fx.nodes.biq.frequency.setTargetAtTime(fx.params.cutoff, audioCtx.currentTime, 0.01);
      renderTrackFxSummary(lp.index);
    });
    $('#lpQ').addEventListener('input', e=>{
      fx.params.q = parseFloat(e.target.value); $('#lpQVal').textContent = fx.params.q.toFixed(2);
      if (fx.nodes?.biq) fx.nodes.biq.Q.setTargetAtTime(fx.params.q, audioCtx.currentTime, 0.01);
    });
    return;
  }
  if (fx.type==='HighPass'){
    $('#hpCut').addEventListener('input', e=>{
      fx.params.cutoff = parseFloat(e.target.value); $('#hpCutVal').textContent = Math.round(fx.params.cutoff)+' Hz';
      if (fx.nodes?.biq) fx.nodes.biq.frequency.setTargetAtTime(fx.params.cutoff, audioCtx.currentTime, 0.01);
      renderTrackFxSummary(lp.index);
    });
    $('#hpQ').addEventListener('input', e=>{
      fx.params.q = parseFloat(e.target.value); $('#hpQVal').textContent = fx.params.q.toFixed(2);
      if (fx.nodes?.biq) fx.nodes.biq.Q.setTargetAtTime(fx.params.q, audioCtx.currentTime, 0.01);
    });
    return;
  }
  if (fx.type==='Pan'){
    $('#pan').addEventListener('input', e=>{
      fx.params.pan = parseFloat(e.target.value); $('#panVal').textContent = fx.params.pan.toFixed(2);
      if (fx.nodes?.panner) fx.nodes.panner.pan.setTargetAtTime(fx.params.pan, audioCtx.currentTime, 0.01);
      renderTrackFxSummary(lp.index);
    });
    return;
  }
  if (fx.type==='Delay'){
    $('#dTime').addEventListener('input', e=>{
      fx.params.timeSec = parseInt(e.target.value,10)/1000; $('#dTimeVal').textContent = `${parseInt(e.target.value,10)} ms`;
      if (fx.nodes?.d) fx.nodes.d.delayTime.setTargetAtTime(fx.params.timeSec, audioCtx.currentTime, 0.01);
      renderTrackFxSummary(lp.index);
    });
    $('#dFb').addEventListener('input', e=>{
      fx.params.feedback = parseInt(e.target.value,10)/100; $('#dFbVal').textContent = `${parseInt(e.target.value,10)}%`;
      if (fx.nodes?.fb) fx.nodes.fb.gain.setTargetAtTime(clamp(fx.params.feedback,0,0.95), audioCtx.currentTime, 0.01);
    });
    $('#dMix').addEventListener('input', e=>{
      fx.params.mix = parseInt(e.target.value,10)/100; $('#dMixVal').textContent = `${parseInt(e.target.value,10)}%`;
      if (fx.nodes?.wet) fx.nodes.wet.gain.setTargetAtTime(clamp(fx.params.mix,0,1), audioCtx.currentTime, 0.01);
    });
    return;
  }
  if (fx.type==='Compressor'){
    $('#cTh').addEventListener('input', e=>{
      fx.params.threshold = parseInt(e.target.value,10); $('#cThVal').textContent = fx.params.threshold+' dB';
      if (fx.nodes?.comp) fx.nodes.comp.threshold.setTargetAtTime(fx.params.threshold, audioCtx.currentTime, 0.01);
    });
    $('#cRa').addEventListener('input', e=>{
      fx.params.ratio = parseFloat(e.target.value); $('#cRaVal').textContent = fx.params.ratio+':1';
      if (fx.nodes?.comp) fx.nodes.comp.ratio.setTargetAtTime(fx.params.ratio, audioCtx.currentTime, 0.01);
    });
    $('#cKn').addEventListener('input', e=>{
      fx.params.knee = parseInt(e.target.value,10); $('#cKnVal').textContent = fx.params.knee+' dB';
      if (fx.nodes?.comp) fx.nodes.comp.knee.setTargetAtTime(fx.params.knee, audioCtx.currentTime, 0.01);
    });
    $('#cAt').addEventListener('input', e=>{
      fx.params.attack = parseFloat(e.target.value)/1000; $('#cAtVal').textContent = (fx.params.attack*1000).toFixed(1)+' ms';
      if (fx.nodes?.comp) fx.nodes.comp.attack.setTargetAtTime(fx.params.attack, audioCtx.currentTime, 0.01);
    });
    $('#cRl').addEventListener('input', e=>{
      fx.params.release = parseFloat(e.target.value)/1000; $('#cRlVal').textContent = (fx.params.release*1000).toFixed(0)+' ms';
      if (fx.nodes?.comp) fx.nodes.comp.release.setTargetAtTime(fx.params.release, audioCtx.currentTime, 0.01);
    });
    return;
  }
}

// ======= LIVE MIC BUTTON =======
const monitorBtn = $('#monitorBtn');
if (monitorBtn){
  monitorBtn.addEventListener('click', async ()=>{
    await ensureMic();
    liveMicMonitoring = !liveMicMonitoring;
    liveMicMonitorGain.gain.value = liveMicMonitoring ? 1 : 0;
    monitorBtn.textContent = liveMicMonitoring ? 'Live MIC ON 🎤' : 'Live MIC OFF';
    monitorBtn.classList.toggle('active', liveMicMonitoring);
  });
  monitorBtn.textContent='Live MIC OFF';
}

// ======= BEFORE-FX WIRING & AUDIO UNLOCK =======
wireBeforeFX();

function resumeAudio(){ if (audioCtx.state==='suspended'){ audioCtx.resume(); hideMsg(); } }
window.addEventListener('click', resumeAudio, { once:true });
window.addEventListener('touchstart', resumeAudio, { once:true });
if (audioCtx.state==='suspended'){
  showMsg("👆 Tap anywhere to start audio!<br>Then toggle Before-FX and tweak in the popup. For per-track FX: use 🎛 FX Menu.", "#22ff88");
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('nudgeMs')?.addEventListener('input', e=>{
      const v = parseInt(e.target.value,10);
      document.getElementById('nudgeVal').textContent = v;
      loopers.forEach(lp => { if (lp) lp.manualNudgeMs = v; });
    });
    document.getElementById('prerollMs')?.addEventListener('input', e=>{
      const v = parseInt(e.target.value,10);
      document.getElementById('prerollVal').textContent = v;
      loopers.forEach(lp => { if (lp) lp.prerecordMs = v; });
    });
    document.getElementById('overdubGain')?.addEventListener('input', e=>{
      const v = parseFloat(e.target.value);
      document.getElementById('overdubGainVal').textContent = v.toFixed(2);
      loopers.forEach(lp => { if (lp) lp.overdubGain = v; });
    });

    // Auto-Tune Button Handler
    document.getElementById('autoTuneBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('autoTuneBtn');
        if (!btn) return;

        btn.disabled = true;
        btn.textContent = 'Measuring...';
        showMsg('Calibrating audio latency... Please be quiet.', '#3b82f6');

        try {
            await ensureMic(); // Make sure audio context and mic are ready

            if (typeof latency === 'undefined' || typeof latency.measureOnce !== 'function') {
                throw new Error('Latency measurement script not loaded.');
            }

            const result = await latency.measureOnce();
            const detectedLatency = Math.round(result.latencyMs);

            // The nudge needs to be negative to compensate for the latency
            const newNudgeValue = -detectedLatency;

            // Clamp the value to the slider's min/max range [-100, 100]
            const clampedNudge = Math.max(-100, Math.min(100, newNudgeValue));

            // Update the UI controls
            const nudgeSlider = document.getElementById('nudgeMs');
            const nudgeValueSpan = document.getElementById('nudgeVal');
            if (nudgeSlider) nudgeSlider.value = clampedNudge;
            if (nudgeValueSpan) nudgeValueSpan.textContent = clampedNudge;

            // Apply the new setting to all looper instances
            loopers.forEach(lp => {
                if (lp) lp.manualNudgeMs = clampedNudge;
            });

            showMsg(`✅ Calibration complete! Latency: ${detectedLatency}ms. Nudge set to ${clampedNudge}ms.`, '#22c55e');

        } catch (error) {
            console.error('Auto-tune failed:', error);
            showMsg(`❌ Calibration failed. Please try again. Error: ${error.message}`, '#ef4444');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Auto-Tune ⚙️';
            setTimeout(hideMsg, 5000);
        }
    });
});
