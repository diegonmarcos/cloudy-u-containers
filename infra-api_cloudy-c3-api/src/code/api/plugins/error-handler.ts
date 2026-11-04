import type { FastifyError, FastifyRequest, FastifyReply } from "fastify";

export function errorHandler(error: FastifyError, _req: FastifyRequest, reply: FastifyReply) {
  const statusCode = error.statusCode ?? 500;
  reply.code(statusCode).send({
    error: error.message,
    statusCode,
  });
}
