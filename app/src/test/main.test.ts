/**
 * Tests for the books CRUD API.
 *
 * Replaces app/test_main.py (pytest). Uses Bun's built-in test runner.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../main';
import { db, initDb } from '../db';
import { books } from '../models';

// Test helpers: insert/clear books directly via Drizzle
async function clearBooks() {
  await db.delete(books);
}

async function createBookViaApi(app: FastifyInstance, book: { title: string; author: string; publisher: string }) {
  return app.inject({
    method: 'POST',
    url: '/books',
    body: book,
  });
}

const TEST_BOOKS = [
  { title: 'Carrie', author: 'Stephen King', publisher: 'TestPublisher' },
  { title: 'Ready Player One', author: 'Ernest Cline', publisher: 'TestPublisher' },
  { title: 'The Shining', author: 'Stephen King', publisher: 'TestPublisher' },
];

describe('App', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    await initDb();
    app = createApp();
    await app.ready();
  });

  afterAll(async () => {
    // app.close() triggers the onClose hook which closes the pool,
    // so we only need to close the app here.
    await app.close();
  });

  beforeEach(async () => {
    await clearBooks();
  });

  describe('Application creation', () => {
    it('should create the app successfully', () => {
      expect(app).toBeDefined();
    });

    it('should initialize database tables', async () => {
      const result = await db.select().from(books).limit(1);
      expect(result).toBeDefined();
    });
  });

  describe('Book CRUD Tests', () => {
    it('should create a new book', async () => {
      const res = await createBookViaApi(app, TEST_BOOKS[0]);
      expect(res.statusCode).toBe(201);
      const book = JSON.parse(res.body);
      expect(book.title).toBe(TEST_BOOKS[0].title);
      expect(book.author).toBe(TEST_BOOKS[0].author);
      expect(book.id).toBeDefined();
      expect(book.id).toBeGreaterThan(0);
      expect(book.publisher).toBe(TEST_BOOKS[0].publisher);
    });

    it('should allow two books with the same author', async () => {
      const res1 = await createBookViaApi(app, TEST_BOOKS[0]); // Carrie, Stephen King
      expect(res1.statusCode).toBe(201);
      const res2 = await createBookViaApi(app, TEST_BOOKS[2]); // The Shining, Stephen King
      expect(res2.statusCode).toBe(201);

      const allRes = await app.inject({ method: 'GET', url: '/books' });
      const allBooks = JSON.parse(allRes.body);
      expect(allBooks.length).toBe(2);
      expect(allBooks.some((b: any) => b.title === 'Carrie')).toBe(true);
      expect(allBooks.some((b: any) => b.title === 'The Shining')).toBe(true);
      expect(allBooks.filter((b: any) => b.author === 'Stephen King').length).toBe(2);
    });

    it('should get all books', async () => {
      await createBookViaApi(app, TEST_BOOKS[0]);
      await createBookViaApi(app, TEST_BOOKS[1]);

      const res = await app.inject({ method: 'GET', url: '/books' });
      expect(res.statusCode).toBe(200);
      const allBooks = JSON.parse(res.body);
      expect(allBooks.length).toBe(2);
      expect(allBooks[0].title).toBe(TEST_BOOKS[0].title);
      expect(allBooks[0].author).toBe(TEST_BOOKS[0].author);
      expect(allBooks[0].id).toBeDefined();
      expect(allBooks[0].publisher).toBe(TEST_BOOKS[0].publisher);
      expect(allBooks[1].title).toBe(TEST_BOOKS[1].title);
      expect(allBooks[1].author).toBe(TEST_BOOKS[1].author);
      expect(allBooks[1].id).toBeDefined();
      expect(allBooks[1].publisher).toBe(TEST_BOOKS[1].publisher);
    });

    it('should get all books with limit and skip', async () => {
      await createBookViaApi(app, TEST_BOOKS[0]);
      await createBookViaApi(app, TEST_BOOKS[1]);
      await createBookViaApi(app, TEST_BOOKS[2]);

      const limitedRes = await app.inject({ method: 'GET', url: '/books?limit=1' });
      expect(limitedRes.statusCode).toBe(200);
      const limited = JSON.parse(limitedRes.body);
      expect(limited.length).toBe(1);

      const skippedRes = await app.inject({ method: 'GET', url: '/books?skip=1&limit=2' });
      expect(skippedRes.statusCode).toBe(200);
      const skipped = JSON.parse(skippedRes.body);
      expect(skipped.length).toBe(2);
      expect(skipped[0].title).not.toBe(TEST_BOOKS[0].title);
    });

    it('should reject invalid limit query param', async () => {
      const res = await app.inject({ method: 'GET', url: '/books?limit=abc' });
      expect(res.statusCode).toBe(400);
    });

    it('should get a specific book by ID', async () => {
      const createRes = await createBookViaApi(app, TEST_BOOKS[0]);
      const created = JSON.parse(createRes.body);

      const res = await app.inject({ method: 'GET', url: `/books/${created.id}` });
      expect(res.statusCode).toBe(200);
      const book = JSON.parse(res.body);
      expect(book.id).toBe(created.id);
      expect(book.title).toBe(TEST_BOOKS[0].title);
      expect(book.author).toBe(TEST_BOOKS[0].author);
      expect(book.publisher).toBe(TEST_BOOKS[0].publisher);
    });

    it('should return 400 for non-numeric book ID on GET', async () => {
      const res = await app.inject({ method: 'GET', url: '/books/abc' });
      expect(res.statusCode).toBe(400);
    });

    it('should update a book', async () => {
      const createRes = await createBookViaApi(app, TEST_BOOKS[0]);
      const created = JSON.parse(createRes.body);

      const res = await app.inject({
        method: 'PUT',
        url: `/books/${created.id}`,
        body: TEST_BOOKS[1],
      });
      expect(res.statusCode).toBe(200);
      const updated = JSON.parse(res.body);
      expect(updated.title).toBe(TEST_BOOKS[1].title);
      expect(updated.author).toBe(TEST_BOOKS[1].author);
      expect(updated.id).toBe(created.id);
      expect(updated.publisher).toBe(TEST_BOOKS[1].publisher);
    });

    it('should delete a book', async () => {
      const createRes = await createBookViaApi(app, TEST_BOOKS[0]);
      const created = JSON.parse(createRes.body);

      const res = await app.inject({
        method: 'DELETE',
        url: `/books/${created.id}`,
      });
      expect(res.statusCode).toBe(200);
      const deleted = JSON.parse(res.body);
      expect(deleted.id).toBe(created.id);

      // Verify deleted
      const getRes = await app.inject({ method: 'GET', url: `/books/${created.id}` });
      expect(getRes.statusCode).toBe(404);
    });

    it('should return 404 for nonexistent book operations', async () => {
      const getRes = await app.inject({ method: 'GET', url: '/books/999999' });
      expect(getRes.statusCode).toBe(404);

      const putRes = await app.inject({
        method: 'PUT',
        url: '/books/999999',
        body: TEST_BOOKS[0],
      });
      expect(putRes.statusCode).toBe(404);

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/books/999999',
      });
      expect(delRes.statusCode).toBe(404);
    });
  });

  describe('Trailing slash handling', () => {
    it('should handle both /books and /books/ for GET', async () => {
      await createBookViaApi(app, TEST_BOOKS[0]);

      const noSlash = await app.inject({ method: 'GET', url: '/books' });
      const withSlash = await app.inject({ method: 'GET', url: '/books/' });

      expect(noSlash.statusCode).toBe(200);
      expect(withSlash.statusCode).toBe(200);
      expect(JSON.parse(noSlash.body).length).toBe(1);
      expect(JSON.parse(withSlash.body).length).toBe(1);
    });

    it('should handle both /books and /books/ for POST', async () => {
      const noSlash = await app.inject({
        method: 'POST',
        url: '/books',
        body: TEST_BOOKS[0],
      });
      const withSlash = await app.inject({
        method: 'POST',
        url: '/books/',
        body: TEST_BOOKS[1],
      });

      expect(noSlash.statusCode).toBe(201);
      expect(withSlash.statusCode).toBe(201);
    });

    it('should handle both /books/:id and /books/:id/ for GET', async () => {
      const createRes = await createBookViaApi(app, TEST_BOOKS[0]);
      const { id } = JSON.parse(createRes.body);

      const noSlash = await app.inject({ method: 'GET', url: `/books/${id}` });
      const withSlash = await app.inject({ method: 'GET', url: `/books/${id}/` });

      expect(noSlash.statusCode).toBe(200);
      expect(withSlash.statusCode).toBe(200);
    });
  });
});
