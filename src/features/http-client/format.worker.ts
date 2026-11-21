import { prettyBody, type BodyKind } from "./format";

self.onmessage = (event: MessageEvent<{ kind: BodyKind; body: string }>) => {
  self.postMessage(prettyBody(event.data.kind, event.data.body));
};
