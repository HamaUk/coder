// Attachments must actually reach the model.
//
// This is the regression that made a user ask "can you read my file i attached"
// after the UI showed the 📎 chip: the browser sent the attachment, the server
// silently dropped it, and the model answered "I don't see any file".
//
// The model call is stubbed, so what is asserted is exactly the history the
// provider would have received.
const path = require('path');
const ROOT = path.join(__dirname, '..');

// Scratch stores, before anything requires src/store.
process.env.HAMA_DATA_DIR = path.join(__dirname, 'data');
process.env.HAMA_WORKSPACE_DIR = path.join(__dirname, 'workspace');

const agent = require(path.join(ROOT, 'src', 'agent'));
const { handleChat } = require(path.join(ROOT, 'src', 'routes', 'chat'));
const store = require(path.join(ROOT, 'src', 'store'));

const results = [];
function check(name, cond, detail) {
  results.push(!!cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

// Capture the history handed to the provider instead of calling a model.
let seenHistory = null;
agent.runAgent = async ({ history }) => {
  seenHistory = JSON.parse(JSON.stringify(history));
  return { text: 'ok', toolRuns: [], mode: 'direct', reasoning: '' };
};

function fakeRes() {
  const chunks = [];
  return {
    headersSent: false,
    writableEnded: false,
    writeHead() { this.headersSent = true; },
    flushHeaders() {},
    write(s) { chunks.push(String(s)); },
    end() { this.writableEnded = true; },
    // The route subscribes to the RESPONSE's close to notice a client that goes
    // away (that is how a hung-up turn gets aborted), so a stand-in must accept
    // listeners even though this suite never fires one.
    on() {},
    once() {},
    removeListener() {},
    text() { return chunks.join(''); }
  };
}

const FILE_TEXT = '{"apiKey":"sk-sentinel-123","note":"attached"}';
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

(async () => {
  // ---- 1. a code/text attachment is folded into the message --------------
  {
    const res = fakeRes();
    await handleChat({ on() {}, headers: {} }, res, {
      message: 'can you read my file i attached',
      attachments: [{ name: 'secrets_findings.json', mime: 'application/json', type: 'file', text: FILE_TEXT }],
      tools: { web: false, files: false, code: false }
    }, { sendJSON: () => {}, activeStreams: new Map() });

    const userTurn = (seenHistory || []).find((m) => m.role === 'user');
    check('the model received the user turn', !!userTurn);
    check('attached file content reached the model',
      !!userTurn && String(userTurn.content).includes('sk-sentinel-123'),
      userTurn ? String(userTurn.content).slice(0, 90) : '(no user turn)');
    check('the attachment is labelled with its filename',
      !!userTurn && String(userTurn.content).includes('secrets_findings.json'));
    check('the user\'s own question is still there',
      !!userTurn && String(userTurn.content).includes('can you read my file i attached'));
    check('the turn ends with the terminal SSE event', /message_end/.test(res.text()));
  }

  // ---- 2. an image attachment becomes a vision block --------------------
  {
    const res = fakeRes();
    await handleChat({ on() {}, headers: {} }, res, {
      message: 'what is in this picture?',
      attachments: [{ name: 'shot.png', mime: 'image/png', type: 'image', dataUrl: IMAGE_DATA_URL }],
      tools: { web: false, files: false, code: false }
    }, { sendJSON: () => {}, activeStreams: new Map() });

    const userTurn = (seenHistory || []).find((m) => m.role === 'user');
    check('the image is attached to the user turn as vision input',
      !!userTurn && Array.isArray(userTurn.images) && userTurn.images.length === 1);
    check('the vision block carries the data URL',
      !!userTurn && userTurn.images[0].dataUrl === IMAGE_DATA_URL);
    check('image bytes are NOT written into the message text',
      !!userTurn && !String(userTurn.content).includes('iVBORw0KGgo'));
  }

  // ---- 3. the persisted turn records the attachment for the UI ----------
  {
    const chats = store.getChats();
    const last = chats[chats.length - 1];
    const userMsg = (last.messages || []).find((m) => m.role === 'user');
    check('the attachment is persisted as metadata (no base64 in chats.json)',
      !!userMsg && Array.isArray(userMsg.attachments) && userMsg.attachments[0].name === 'shot.png',
      userMsg ? JSON.stringify(userMsg.attachments) : '(none)');
    check('persisted metadata never carries the image bytes',
      !!userMsg && !JSON.stringify(userMsg.attachments).includes('iVBORw0KGgo'));
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
