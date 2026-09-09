/**
 * Data access layer using Drizzle ORM.
 *
 * Replaces app/repositories.py (SQLAlchemy data access).
 */

import { eq } from 'drizzle-orm';
import { db } from './db';
import { books, BookIn } from './models';

/** Create a new book. */
export async function createBook(book: BookIn): Promise<typeof books.$inferSelect> {
  const [result] = await db.insert(books).values(book).returning();
  return result;
}

/** Get all books with optional pagination. */
export async function getBooks(skip = 0, limit = 10): Promise<(typeof books.$inferSelect)[]> {
  return db.select().from(books).offset(skip).limit(limit);
}

/** Get a single book by ID. */
export async function getBook(bookId: number): Promise<typeof books.$inferSelect | undefined> {
  const [result] = await db.select().from(books).where(eq(books.id, bookId)).limit(1);
  return result;
}

/** Update a book by ID. Returns the updated book or undefined if not found. */
export async function updateBook(
  bookId: number,
  book: BookIn,
): Promise<typeof books.$inferSelect | undefined> {
  const [result] = await db
    .update(books)
    .set({ title: book.title, author: book.author, publisher: book.publisher })
    .where(eq(books.id, bookId))
    .returning();
  return result;
}

/** Delete a book by ID. Returns the deleted book or undefined if not found. */
export async function deleteBook(bookId: number): Promise<typeof books.$inferSelect | undefined> {
  const [result] = await db.delete(books).where(eq(books.id, bookId)).returning();
  return result;
}