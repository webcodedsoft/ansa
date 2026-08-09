import { Injectable, type NestMiddleware } from "@nestjs/common";

import { REQUEST_ID_HEADER } from "./problem";
import { stateOf, type ApiRequest } from "./request";

/**
 * Returns the request's id in the response, so a screenshot of an error is enough to find
 * the log line behind it.
 *
 * The id is generated rather than read from an inbound `X-Request-Id`: honouring a
 * client-supplied one lets a caller collide with, or forge, another request's identifier
 * in our logs. When a proxy we control starts supplying one, this is where to accept it.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(
    request: ApiRequest,
    response: { setHeader(name: string, value: string): void },
    next: () => void,
  ): void {
    response.setHeader(REQUEST_ID_HEADER, stateOf(request).requestId);
    next();
  }
}
