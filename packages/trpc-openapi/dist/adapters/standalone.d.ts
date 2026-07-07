import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenApiRouter } from "../types";
import { type CreateOpenApiNodeHttpHandlerOptions } from "./node-http/core";
export type CreateOpenApiHttpHandlerOptions<TRouter extends OpenApiRouter> = CreateOpenApiNodeHttpHandlerOptions<TRouter, IncomingMessage, ServerResponse>;
export declare const createOpenApiHttpHandler: <TRouter extends OpenApiRouter>(opts: CreateOpenApiHttpHandlerOptions<TRouter>) => (req: IncomingMessage, res: ServerResponse) => Promise<void>;
//# sourceMappingURL=standalone.d.ts.map