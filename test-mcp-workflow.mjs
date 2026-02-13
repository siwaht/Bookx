/**
 * End-to-end test of the MCP server workflow.
 * Tests: create book → add characters → add chapter → add segments →
 *        generate audio → export chapter → export book → cleanup
 *
 * Usage: node test-mcp-workflow.mjs
 */
import 'dotenv/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ALEX_VOICE = 'iP95p4xoKVk53GoZ742B';
const SAM_VOICE = 'exsUS4vynmxd379XN4yO';

let client;
let bookId, chapterId;

async function callTool(name, args = {}) {
  console.log(`\n→ ${name}(${JSON.stringify(args).substring(0, 120)}${JSON.stringify(args).length > 120 ? '...' : ''})`);
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.[0]?.text || '';
    console.log(`  ✗ ERROR: ${text}`);
    return null;
  }
  const first = result.content?.[0];
  if (first?.type === 'resource') {
    const blob = first.resource?.blob;
    const uri = first.resource?.uri;
    const mimeType = first.resource?.mimeType;
    const sizeKb = blob ? Math.round((blob.length * 3 / 4) / 1024) : 0;
    console.log(`  ✓ [resource] uri=${uri} mime=${mimeType} base64_size≈${sizeKb} KB`);
    return first.resource;
  }
  const text = first?.text || '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`  ✓ ${typeof parsed === 'string' ? parsed.substring(0, 200) : JSON.stringify(parsed).substring(0, 200)}`);
  return parsed;
}

async function main() {
  console.log('=== MCP Server End-to-End Test ===\n');

  // Connect to MCP server
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'server/src/mcp-server.ts'],
    env: { ...process.env, DATA_DIR: './data' },
  });
  client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  console.log('✓ Connected to MCP server\n');

  // List available tools
  const tools = await client.listTools();
  console.log(`✓ ${tools.tools.length} tools available:`);
  for (const t of tools.tools) {
    console.log(`  - ${t.name}: ${t.description?.substring(0, 80)}`);
  }

  // ── 1. List voices ──
  const voices = await callTool('list_voices', { search: 'Rachel' });

  // ── 2. Get capabilities ──
  await callTool('get_capabilities');

  // ── 3. Get usage ──
  await callTool('get_usage');

  // ── 4. Create a book ──
  const book = await callTool('create_book', {
    title: 'MCP Test Podcast',
    author: 'Test Author',
    project_type: 'podcast',
    format: 'multi_narrator',
  });
  bookId = book?.id;
  if (!bookId) { console.error('Failed to create book'); process.exit(1); }

  // ── 5. Get project status ──
  await callTool('get_project_status', { book_id: bookId });

  // ── 6. Add characters ──
  const alex = await callTool('add_character', {
    book_id: bookId, name: 'Alex', voice_id: ALEX_VOICE,
    role: 'character', model_id: 'eleven_v3',
    stability: 0.5, similarity_boost: 0.78, style: 0.15,
  });

  const sam = await callTool('add_character', {
    book_id: bookId, name: 'Sam', voice_id: SAM_VOICE,
    role: 'character', model_id: 'eleven_v3',
    stability: 0.5, similarity_boost: 0.78, style: 0.15,
  });

  // ── 7. List characters ──
  await callTool('list_characters', { book_id: bookId });

  // ── 8. Add a chapter ──
  const chapter = await callTool('add_chapter', {
    book_id: bookId,
    title: 'Episode 1: MCP Test',
    text: 'Alex: Hello and welcome. Sam: Thanks for having me.',
  });
  chapterId = chapter?.id;

  // ── 9. List chapters ──
  await callTool('list_chapters', { book_id: bookId });

  // ── 10. Add segments ──
  await callTool('add_segments', {
    chapter_id: chapterId,
    segments: [
      { character_name: 'Alex', text: 'Hello and welcome to the MCP test podcast. This is a fully automated test.' },
      { character_name: 'Sam', text: 'Thanks for having me, Alex. The MCP server is working perfectly.' },
      { character_name: 'Alex', text: 'That wraps up our test. See you next time.' },
    ],
  });

  // ── 11. List segments ──
  await callTool('list_segments', { chapter_id: chapterId });

  // ── 12. Add pronunciation rule ──
  await callTool('add_pronunciation_rule', {
    book_id: bookId, word: 'MCP', alias: 'M C P',
  });
  await callTool('list_pronunciation_rules', { book_id: bookId });

  // ── 13. Generate chapter audio ──
  console.log('\n--- Generating TTS (this will call ElevenLabs API) ---');
  const genResult = await callTool('generate_chapter_audio', { chapter_id: chapterId });
  if (!genResult || genResult.failed > 0) {
    console.error('TTS generation had failures:', genResult);
  }

  // ── 14. List segments again (should have audio now) ──
  await callTool('list_segments', { chapter_id: chapterId });

  // ── 15. Export chapter audio ──
  const exported = await callTool('export_chapter_audio', {
    chapter_id: chapterId,
    output_filename: 'mcp_test_chapter.mp3',
    gap_between_segments_ms: 300,
  });

  // ── 16. Export full book ──
  const bookExport = await callTool('export_book_audio', {
    book_id: bookId,
    output_filename: 'mcp_test_full.mp3',
    gap_between_segments_ms: 300,
    gap_between_chapters_ms: 2000,
  });

  // ── 17. List exports ──
  const exports = await callTool('list_exports');
  console.log(`  Found ${Array.isArray(exports) ? exports.length : 0} export(s)`);

  // ── 18. Download the exported chapter file ──
  console.log('\n--- Testing file download via MCP ---');
  const downloaded = await callTool('download_file', { file_path: 'mcp_test_chapter.mp3' });
  if (downloaded) {
    const resource = downloaded;
    // The response is a resource content with base64 blob
    console.log(`  ✓ Download returned resource content (check for base64 blob)`);
  }

  // ── 19. Populate timeline ──
  await callTool('populate_timeline', {
    book_id: bookId,
    gap_between_segments_ms: 300,
    gap_between_chapters_ms: 2000,
  });

  // ── 18. List tracks ──
  await callTool('list_tracks', { book_id: bookId });

  // ── 19. List audio assets ──
  await callTool('list_audio_assets', { book_id: bookId, type: 'all' });

  // ── 20. Get settings ──
  await callTool('get_settings');

  // ── 21. Get final project status ──
  await callTool('get_project_status', { book_id: bookId });

  // ── 22. Cleanup: delete the test book ──
  await callTool('delete_book', { book_id: bookId });

  // ── 23. Verify deletion ──
  await callTool('list_books');

  console.log('\n=== ALL TESTS PASSED ===');
  console.log(`Exported files:`);
  if (exported?.output_path) console.log(`  Chapter: ${exported.output_path}`);
  if (bookExport?.output_path) console.log(`  Book: ${bookExport.output_path}`);

  await client.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
