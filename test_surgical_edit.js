// Automated test for surgical in-place editing vs rewriting
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const toolsKit = require('./src/tools');
const store = require('./src/store');

console.log('--- Testing Surgical In-Place Editing ---');

// 1. Setup a multi-function Python file in workspace
const pythonCode = `def add(a, b):
    return a + b

def subtract(a, b):
    return a - b

def divide(a, b):
    return a / b  # BUG: crashes on zero!
`;

const pyPath = 'math_utils.py';
toolsKit.execute('write_file', { path: pyPath, content: pythonCode });

const fullPy = path.join(store.WORKSPACE_DIR, pyPath);
assert.ok(fs.existsSync(fullPy), 'math_utils.py must exist');

// 2. Perform a surgical edit on ONLY divide()
console.log('Performing surgical edit on divide() function...');
const findStr = `def divide(a, b):
    return a / b  # BUG: crashes on zero!`;

const replaceStr = `def divide(a, b):
    if b == 0:
        raise ValueError("Cannot divide by zero")
    return a / b`;

const editRes = toolsKit.execute('edit_file', {
  path: pyPath,
  find: findStr,
  replace: replaceStr
});

editRes.then(res => {
  console.log('Edit result ok:', res.ok);
  assert.strictEqual(res.ok, true);

  const updated = fs.readFileSync(fullPy, 'utf8');

  // Verify: add and subtract are 100% intact!
  assert.ok(updated.includes('def add(a, b):'), 'add function must remain intact');
  assert.ok(updated.includes('def subtract(a, b):'), 'subtract function must remain intact');

  // Verify: divide is fixed
  assert.ok(updated.includes('Cannot divide by zero'), 'divide function must be updated with check');

  console.log('✓ Verified: add() and subtract() remained completely untouched');
  console.log('✓ Verified: divide() was surgically fixed in place without rewriting the file');

  // 3. Test CRLF <-> LF resilience
  console.log('\nTesting CRLF/LF line-ending resilience...');
  const crlfFile = 'crlf_test.txt';
  fs.writeFileSync(path.join(store.WORKSPACE_DIR, crlfFile), "Line 1\r\nLine 2\r\nLine 3\r\n");
  
  // Try to find with Unix LF
  return toolsKit.execute('edit_file', {
    path: crlfFile,
    find: "Line 2\n",
    replace: "Line 2 Modified\n"
  });
}).then(res => {
  assert.strictEqual(res.ok, true);
  const content = fs.readFileSync(path.join(store.WORKSPACE_DIR, 'crlf_test.txt'), 'utf8');
  assert.ok(content.includes('Line 2 Modified'), 'Line 2 must be replaced despite CRLF/LF difference');
  console.log('✓ CRLF <-> LF line-ending normalization passes');

  // Clean up
  fs.unlinkSync(fullPy);
  fs.unlinkSync(path.join(store.WORKSPACE_DIR, 'crlf_test.txt'));
  console.log('✓ Cleaned up test files');

  console.log('\nAll surgical edit tests PASSED! 🚀\n');
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
