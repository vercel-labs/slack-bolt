import { defineHandler } from "nitro";
import { receiver } from "../../../bolt/app";

// Bolt verifies Slack's signature against the raw body, so hand the request to
// the receiver without reading it first.
export default defineHandler((event) => receiver.fetch(event.req));
