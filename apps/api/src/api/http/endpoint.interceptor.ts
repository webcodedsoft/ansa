import {
  Injectable,
  InternalServerErrorException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";

import { specOf, type EndpointSpec } from "./endpoint";
import { ValidationFailed } from "./problem";
import { isApiPath, stateOf, type ApiRequest } from "./request";
import { parse, type FieldError, type Schema } from "./schema";

/**
 * Validates what comes in and projects what goes out, from the endpoint's own schemas.
 *
 * Both halves matter, and the second is the one that is easy to skip.
 *
 * **In:** path parameters, query string and body are checked against the schemas the
 * `@Endpoint` declared, with coercion for the two that arrive as strings. A handler
 * parameter typed from those schemas is therefore telling the truth, and an unrecognised
 * field is a 422 rather than something silently ignored.
 *
 * **Out:** the returned value is projected through the response schema, which drops
 * anything the schema does not name. That makes the schema an allowlist, and the practical
 * consequence is worth being explicit about: adding a column to a table cannot leak it
 * through an endpoint nobody updated. A `password_hash` that finds its way into a row
 * object never reaches the wire. It also means `openapi.json` cannot describe a response
 * the API does not actually send, because the same object enforces both.
 */
@Injectable()
export class EndpointInterceptor implements NestInterceptor {
  private validate(
    schema: Schema<unknown> | undefined,
    value: unknown,
    where: string,
    coerce: boolean,
    errors: FieldError[],
  ): unknown {
    // An endpoint that declares no schema for a part accepts nothing from it. Handing the
    // raw value over instead would make "I forgot to declare the body" indistinguishable
    // from "this endpoint takes no body".
    if (schema === undefined) return undefined;
    const result = parse(schema, value ?? {}, { coerce, unknown: "reject" });
    if (result.ok) return result.value;
    errors.push(...result.errors.map((e) => ({ ...e, path: e.path === "" ? where : `${where}.${e.path}` })));
    return undefined;
  }

  private project(spec: EndpointSpec, value: unknown): unknown {
    if (spec.response === undefined) return undefined;
    const result = parse(spec.response, value, { unknown: "strip" });
    if (result.ok) return result.value;
    // The handler returned something its own declared schema rejects. That is a bug in us,
    // never in the caller, and it must not be answered with a 422 that blames them.
    throw new InternalServerErrorException(
      `response did not match its schema: ${result.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`,
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const request = context.switchToHttp().getRequest<ApiRequest>();
    if (!isApiPath(request.originalUrl)) return next.handle();

    const spec = specOf(context.getHandler());
    // ApiGuard has already refused this, so it is unreachable in a running application.
    // It is here so the interceptor is safe on its own, rather than safe because of the
    // order two globally-registered things happen to be in.
    if (spec === undefined) throw new InternalServerErrorException("this route declares no @Endpoint");

    const errors: FieldError[] = [];
    const validated = {
      params: this.validate(spec.params, request.params, "params", true, errors),
      query: this.validate(spec.query, request.query, "query", true, errors),
      body: this.validate(spec.body, request.body, "body", false, errors),
    };
    if (errors.length > 0) throw new ValidationFailed(errors);

    stateOf(request).validated = validated;
    return next.handle().pipe(map((value: unknown) => this.project(spec, value)));
  }
}
