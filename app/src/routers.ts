/**
 * Fastify routes for the books CRUD API.
 *
 * Uses Zod schemas as the single source of truth, converted to JSON Schema
 * via zod-to-json-schema. Fastify's native ajv validator handles request
 * validation and error responses.
 */

import type { FastifyInstance, FastifyError } from "fastify";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { BookInSchema, BookOutSchema, BookIn, BookOut } from "./models";
import {
  createBook,
  getBooks,
  getBook,
  updateBook,
  deleteBook,
} from "./repositories";

// ── JSON Schema derived from Zod schemas ──────────────────────────────────────

const bookInSchema = zodToJsonSchema(BookInSchema);
const bookOutSchema = zodToJsonSchema(BookOutSchema);
const bookListSchema = zodToJsonSchema(z.array(BookOutSchema));

// Params: id must be a positive integer (validated as string pattern from URL)
const bookIdParamSchema = {
  type: "object",
  properties: {
    id: { type: "string", pattern: "^[0-9]+$" },
  },
  required: ["id"],
  additionalProperties: false,
};

// Querystring: skip/limit for pagination
const querySchema = {
  type: "object",
  properties: {
    skip: { type: "string", pattern: "^[0-9]+$" },
    limit: { type: "string", pattern: "^[0-9]+$" },
  },
  required: [],
  additionalProperties: false,
};

// ── Error response helper ────────────────────────────────────────────────────

interface ApiError {
  ok: false;
  error: { title: string; status: number };
  message: string;
}

function notFound(message = "Book not found"): ApiError {
  return { ok: false, error: { title: "Not Found", status: 404 }, message };
}

function serverError(message = "An unexpected error occurred"): ApiError {
  return {
    ok: false,
    error: { title: "Internal Server Error", status: 500 },
    message,
  };
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerRoutes(app: FastifyInstance) {
  // Centralized error handler.
  // - Validation errors (400) from Fastify's schema validator → 400 with details
  // - Unexpected errors (500) → logged server-side, sanitized message to client
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode || 500;

    if (statusCode >= 500) {
      request.log.error(error);
      reply.code(500).send(serverError());
      return;
    }

    // Client errors (400, etc.) — preserve the status code
    reply.code(statusCode).send({
      ok: false,
      error: {
        title: statusCode === 400 ? "Bad Request" : "Client Error",
        status: statusCode,
      },
      message: error.message || "Request validation failed",
    });
  });

  // ── Create a book ─────────────────────────────────────────────────────────

  app.post<{ Body: BookIn }>(
    "/books",
    { schema: { body: bookInSchema, response: { 201: bookOutSchema } } },
    async (request, reply) => {
      try {
        const book: BookOut = await createBook(request.body);
        return reply.code(201).send(book);
      } catch (e) {
        // Log full error server-side, return generic message to client
        const err = e instanceof Error ? e : new Error(String(e));
        request.log.error(err, "Failed to create book");
        return reply.code(500).send(serverError("Failed to create book"));
      }
    },
  );

  // ── Get all books (with pagination) ────────────────────────────────────────

  app.get<{ Querystring: { skip?: string; limit?: string } }>(
    "/books",
    { schema: { querystring: querySchema, response: { 200: bookListSchema } } },
    async (request, reply) => {
      const skip = request.query.skip ? parseInt(request.query.skip, 10) : 0;
      const limit = request.query.limit
        ? parseInt(request.query.limit, 10)
        : 10;
      const allBooks = await getBooks(skip, limit);
      return allBooks;
    },
  );

  // ── Get a book by ID ───────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    "/books/:id",
    { schema: { params: bookIdParamSchema, response: { 200: bookOutSchema } } },
    async (request, reply) => {
      const book = await getBook(Number(request.params.id));
      if (!book) {
        return reply.code(404).send(notFound());
      }
      return book;
    },
  );

  // ── Update a book ──────────────────────────────────────────────────────────

  app.put<{ Params: { id: string }; Body: BookIn }>(
    "/books/:id",
    {
      schema: {
        params: bookIdParamSchema,
        body: bookInSchema,
        response: { 200: bookOutSchema },
      },
    },
    async (request, reply) => {
      const bookId = Number(request.params.id);
      const book = await updateBook(bookId, request.body);
      if (!book) {
        return reply.code(404).send(notFound());
      }
      return book;
    },
  );

  // ── Delete a book ──────────────────────────────────────────────────────────

  app.delete<{ Params: { id: string } }>(
    "/books/:id",
    { schema: { params: bookIdParamSchema, response: { 200: bookOutSchema } } },
    async (request, reply) => {
      const bookId = Number(request.params.id);
      const book = await deleteBook(bookId);
      if (!book) {
        return reply.code(404).send(notFound());
      }
      return book;
    },
  );
}
