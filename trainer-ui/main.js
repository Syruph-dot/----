const logEl = document.getElementById('log');
const runBtn = document.getElementById('run');
const cancelBtn = document.getElementById('cancel');

function appendLog(text, kind='info'){
  const now = new Date().toISOString().slice(11,23);
  logEl.textContent += `[${now}] ${text}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let es = null;
function ensureEventSource(){
  if (es) return;
  es = new EventSource('/events');
  es.onmessage = (ev) => {
    try {
      const obj = JSON.parse(ev.data);
      if (obj.type === 'stdout' || obj.type === 'stderr') appendLog(obj.text, obj.type);
      else if (obj.type === 'info') appendLog(obj.text);
      else if (obj.type === 'error') appendLog('ERROR: ' + (obj.error || obj.text));
      else if (obj.type === 'exit') appendLog(`Command finished: ${obj.cmd} (code=${obj.code})`);
      else if (obj.type === 'done') appendLog('Pipeline finished');
    } catch (e) {
      appendLog(ev.data);
    }
  };
  es.onerror = () => { appendLog('EventSource error or closed'); es.close(); es = null; };
}

runBtn.addEventListener('click', async () => {
  ensureEventSource();
  const opts = {
    episodes: Number(document.getElementById('episodes').value),
    outputDir: document.getElementById('outputDir').value,
    format: document.getElementById('format').value,
    split: document.getElementById('split').value,
    bcDir: document.getElementById('bcDir').value,
    modelDir: document.getElementById('modelDir').value,
    epochs: Number(document.getElementById('epochs').value),
    batchSize: Number(document.getElementById('batchSize').value),
    steps: []
  };
  if (document.getElementById('step-headless').checked) opts.steps.push('headless');
  if (document.getElementById('step-prepare').checked) opts.steps.push('prepare');
  if (document.getElementById('step-train').checked) opts.steps.push('train');
  if (document.getElementById('step-smoke').checked) opts.steps.push('smoke');

  appendLog('Starting pipeline...');
  try {
    const r = await fetch('/api/run-pipeline', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(opts) });
    if (!r.ok) appendLog('Failed to start pipeline: ' + (await r.text()));
  } catch (e) { appendLog('Start request failed: ' + e.message); }
});

cancelBtn.addEventListener('click', async () => {
  try {
    const r = await fetch('/api/cancel', { method: 'POST' });
    appendLog('Cancel request sent');
  } catch (e) { appendLog('Cancel failed: ' + e.message); }
});

// establish event source eagerly
ensureEventSource();

const prepareBtn = document.getElementById('prepare-only');
if (prepareBtn) {
  prepareBtn.addEventListener('click', async () => {
    ensureEventSource();
    const opts = {
      outputDir: document.getElementById('outputDir').value,
      bcDir: document.getElementById('bcDir').value,
      format: document.getElementById('format').value,
      split: document.getElementById('split').value,
      steps: ['prepare']
    };
    appendLog('Starting BC dataset generation...');
    try {
      const r = await fetch('/api/run-pipeline', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(opts) });
      if (!r.ok) appendLog('Failed to start prepare: ' + (await r.text()));
    } catch (e) { appendLog('Start request failed: ' + e.message); }
  });
}
