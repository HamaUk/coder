// Verify multi-file creation capability
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const toolsKit = require('./src/tools');
const store = require('./src/store');

console.log('--- Testing Multi-File Creation ---');

// 1. Test write_files tool directly
const testFiles = [
  { path: 'test_app/index.html', content: '<!DOCTYPE html><html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Hello Multi-File</h1><script src="app.js"></script></body></html>' },
  { path: 'test_app/styles.css', content: 'body { font-family: sans-serif; background: #111; color: #fff; }' },
  { path: 'test_app/app.js', content: 'console.log("Multi-file application initialized!");' },
  { path: 'test_app/config.json', content: '{"version": "1.0.0", "multiFile": true}' }
];

console.log('1. Executing write_files with 4 distinct files...');
const result = toolsKit.execute('write_files', { files: testFiles });

result.then(res => {
  console.log('Result ok:', res.ok);
  console.log('Output:\n', res.output);
  assert.strictEqual(res.ok, true);

  // Check that all 4 files were created in the actual workspace directory
  for (const f of testFiles) {
    const fullPath = path.join(store.WORKSPACE_DIR, f.path);
    assert.ok(fs.existsSync(fullPath), `File ${f.path} must exist in workspace`);
    const content = fs.readFileSync(fullPath, 'utf8');
    assert.strictEqual(content, f.content, `Content of ${f.path} must match`);
    console.log(`✓ Verified file created: ${f.path} (${fs.statSync(fullPath).size} bytes)`);
  }

  // 2. Test sequential write_file calls
  console.log('\n2. Testing sequential write_file calls...');
  const f5 = { path: 'test_app/readme.md', content: '# Multi-File Project Test\nCreated successfully.' };
  return toolsKit.execute('write_file', f5);
}).then(res => {
  assert.strictEqual(res.ok, true);
  const fullPath = path.join(store.WORKSPACE_DIR, 'test_app/readme.md');
  assert.ok(fs.existsSync(fullPath));
  console.log('✓ Verified individual write_file call: test_app/readme.md');

  // Clean up test files
  fs.rmSync(path.join(store.WORKSPACE_DIR, 'test_app'), { recursive: true, force: true });
  console.log('✓ Cleaned up test files');

  console.log('\nAll multi-file tests PASSED! 🚀 The AI can create multiple files seamlessly!\n');
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
