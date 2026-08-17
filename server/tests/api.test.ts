import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createTestApp, closeTestApp, TestContext } from './setup.js';

describe('API Tests', () => {
  let ctx: TestContext;
  let token: string;

  before(async () => {
    ctx = await createTestApp();
  });

  after(async () => {
    await closeTestApp(ctx);
  });

  describe('Health endpoint', () => {
    it('GET /api/health returns 200 with status ok', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/health`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
    });
  });

  describe('Authentication', () => {
    it('POST /api/auth/login with correct password returns token', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'testpassword' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.token, 'Response should contain a token');
      assert.strictEqual(typeof body.token, 'string');
      token = body.token;
    });

    it('POST /api/auth/login with wrong password returns 401', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrongpassword' }),
      });
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.strictEqual(body.error, 'Invalid password');
    });

    it('GET /api/books without token returns 401', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.strictEqual(body.error, 'Authentication required');
    });
  });

  describe('Books CRUD', () => {
    let bookId: string;

    it('POST /api/books creates a book', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Test Book', author: 'Test Author' }),
      });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.ok(body.id);
      assert.strictEqual(body.title, 'Test Book');
      assert.strictEqual(body.author, 'Test Author');
      bookId = body.id;
    });

    it('GET /api/books lists books', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
      assert.ok(body.length >= 1);
      const found = body.find((b: any) => b.id === bookId);
      assert.ok(found, 'Created book should be in the list');
    });

    it('GET /api/books/:id returns book with chapters and characters', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books/${bookId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.id, bookId);
      assert.strictEqual(body.title, 'Test Book');
      assert.ok(Array.isArray(body.chapters));
      assert.ok(Array.isArray(body.characters));
    });

    it('PUT /api/books/:id updates a book', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books/${bookId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Updated Book Title' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.title, 'Updated Book Title');
    });

    it('DELETE /api/books/:id deletes a book', async () => {
      // Create a book to delete
      const createRes = await fetch(`${ctx.baseUrl}/api/books`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Book To Delete' }),
      });
      const created = await createRes.json();

      const res = await fetch(`${ctx.baseUrl}/api/books/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 204);

      // Verify it's gone
      const getRes = await fetch(`${ctx.baseUrl}/api/books/${created.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(getRes.status, 404);
    });
  });

  describe('Chapters CRUD', () => {
    let bookId: string;
    let chapterId: string;

    before(async () => {
      // Create a book for chapter tests
      const res = await fetch(`${ctx.baseUrl}/api/books`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Book for Chapters' }),
      });
      const body = await res.json();
      bookId = body.id;
    });

    it('POST /api/books/:bookId/chapters creates a chapter', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books/${bookId}/chapters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Chapter 1', raw_text: 'Once upon a time...' }),
      });
      assert.strictEqual(res.status, 201);
      const body = await res.json();
      assert.ok(body.id);
      assert.strictEqual(body.title, 'Chapter 1');
      assert.strictEqual(body.raw_text, 'Once upon a time...');
      assert.strictEqual(body.book_id, bookId);
      chapterId = body.id;
    });

    it('GET /api/books/:bookId/chapters lists chapters', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books/${bookId}/chapters`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body));
      assert.ok(body.length >= 1);
      const found = body.find((ch: any) => ch.id === chapterId);
      assert.ok(found, 'Created chapter should be in the list');
    });

    it('PUT /api/books/:bookId/chapters/:id updates a chapter', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/books/${bookId}/chapters/${chapterId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Updated Chapter Title', raw_text: 'Updated text content' }),
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.title, 'Updated Chapter Title');
      assert.strictEqual(body.raw_text, 'Updated text content');
    });

    it('DELETE /api/books/:bookId/chapters/:id deletes a chapter', async () => {
      // Create a chapter to delete
      const createRes = await fetch(`${ctx.baseUrl}/api/books/${bookId}/chapters`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title: 'Chapter to delete', raw_text: 'Delete me' }),
      });
      const created = await createRes.json();

      const res = await fetch(`${ctx.baseUrl}/api/books/${bookId}/chapters/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 204);
    });
  });

  describe('API 404', () => {
    it('GET /api/nonexistent returns JSON error, not HTML', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/nonexistent`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 404);
      const contentType = res.headers.get('content-type');
      assert.ok(contentType?.includes('application/json'), `Expected JSON content-type, got: ${contentType}`);
      const body = await res.json();
      assert.strictEqual(body.error, 'Endpoint not found');
    });
  });
});
