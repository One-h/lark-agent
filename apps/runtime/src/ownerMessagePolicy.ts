export type OwnerMessagePolicyInput = {
  enabled: boolean;
  ownerId: string;
  approverId: string;
  senderId: string;
  trusted: boolean;
  chatType: string;
  messageType: string;
  senderType: string;
  direction: string;
  originalText: string;
  recipient: string;
  text: string;
  contact: { identities: string[]; active: boolean; internal: boolean; unique: boolean };
};

// This is a conservative allowlist, NOT a general sensitive-data classifier.
// Unrecognised free-form content always keeps the existing human approval.
const ordinaryMessages = [
  /^(?:test|hello|hi|你好|您好|早上好|下午好|晚上好|收到|好的|谢谢|辛苦了|谢谢你|不客气|稍等|稍等一下|我到了|我马上到|我晚点到|明天见|待会见|回头见)[!！。.]?$/iu,
  /^[\p{Script=Han}]{2,8}(?:带的|买的|带回来的)(?:小礼物|特产)?[。！!]?$/u,
  /^(?:今天|明天|后天|周[一二三四五六日天])?(?:上午|下午|晚上|中午)?(?:[01]?\d|2[0-3])(?:[:：][0-5]\d|点(?:半|[0-5]?\d分?)?)?(?:开会|见面|碰面)[。！!]?$/u,
  /^(?:今天|明天|后天)?(?:的)?(?:会议|见面|碰面)(?:取消了|取消|改到明天|改到后天|推迟了|提前了)[。！!]?$/u
];
const sensitive = /密码|口令|密钥|验证码|授权码|秘密|机密|保密|隐私|身份证|护照|银行卡|账号|账户|工资|薪资|奖金|病|诊断|医院|药|合同|签约|付款|转账|支付|报价|预算|报销|裁员|离职|解雇|辞退|投诉|举报|担保|承诺|token|secret|password|api[ _-]?key/iu;

export function ownerMessageAllowed(input: OwnerMessagePolicyInput): boolean {
  if (!input.enabled || !input.ownerId || input.ownerId !== input.approverId
    || input.senderId !== input.ownerId || !input.trusted
    || input.chatType !== "p2p" || input.messageType !== "text"
    || input.senderType !== "user" || input.direction !== "inbound"
    || !input.contact.active || !input.contact.internal || !input.contact.unique) return false;
  const match = input.originalText.trim().match(/^(?:请)?(?:跟|和|给|向)\s*([^：:\n]{1,60}?)\s*(?:说句话|说一声|说|发消息|发送消息|发送|发)\s*[：:]\s*([^\n]+)$/u);
  if (!match) return false;
  const recipient = match[1].trim();
  const text = match[2].trim();
  if (!input.contact.identities.includes(recipient) || !input.contact.identities.includes(input.recipient)
    || /[、,，;；]|大家|所有|全体|群|他们|她们|同事们/u.test(recipient)
    || text !== input.text || text.length > 100 || sensitive.test(text)) return false;
  return ordinaryMessages.some((pattern) => pattern.test(text));
}
