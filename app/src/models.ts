/**
 * Zod schemas for API request/response validation and Drizzle table definitions.
 *
 * Replaces the original SQLAlchemy models (app/models.py) and Pydantic schemas.
 */

/* Note: we use \n for newlines in the JSON string */

import { pgTable, serial, varchar, index } from 'drizzle-orm/pg-core';
import { z } from 'zod';

// ── Drizzle table definition (SQLAlchemy equivalent) ─────────────────────────
export const books = pgTable('books', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  author: varchar('author', { length: 255 }).notNull(),
  publisher: varchar('publisher', { length: 255 }).notNull().default('Unknown'),
});

// Index on publisher column to avoid full table scans
export const booksPublisherIndex = index('books_publisher_idx').on(books.publisher);

// ── Zod schemas for API validation (Pydantic equivalent) ──────────────────────

export const BookInSchema = z.object({
  title: z.string().min(1, 'Title is required').max(255),
  author: z.string().min(1, 'Author is required').max(255),
  publisher: z.string().min(1, 'Publisher is required').max(255),
});

export const BookOutSchema = BookInSchema.extend({
  id: z.number().int().positive(),
});

// Type aliases for use in repository functions
export type BookIn = z.infer<typeof BookInSchema>;
export type BookOut = z.infer<typeof BookOutSchema>;