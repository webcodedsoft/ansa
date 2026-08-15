import { redirect } from "next/navigation";

/**
 * There is no dashboard at the root and there should not be one yet.
 *
 * The loop this app exists to serve is configure, call, read. Calls is where you land after
 * placing one and where you go to find out what happened, so it is the home page until
 * something is genuinely more useful on arrival.
 */
const Index = (): never => redirect("/calls");

export default Index;
