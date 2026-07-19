// Sender seam (spec AL11): the approval flow calls this interface; swapping the
// implementation (stub, Gmail SMTP, Gmail API) never touches approval code.
export interface OutboundEmail {
  to: string;
  from: string;
  subject: string;
  body: string;
  draftShortId: string;
}

export interface Sender {
  send(email: OutboundEmail): Promise<{ sentId: string }>;
}
