import assert from "node:assert/strict";
import test from "node:test";
import { ownerMessageAllowed } from "./ownerMessagePolicy.js";

const ordinary = {
  enabled: true, ownerId: "ou_owner", approverId: "ou_owner", senderId: "ou_owner",
  trusted: true, chatType: "p2p", messageType: "text", senderType: "user", direction: "inbound",
  originalText: "跟示例同事说：你好", recipient: "示例同事", text: "你好",
  contact: { identities: ["示例同事", "ou_colleague"], active: true, internal: true, unique: true }
};

test("owner's explicit ordinary message can use the narrow approval exemption", () => {
  assert.equal(ownerMessageAllowed({
    enabled: true, ownerId: "ou_owner", approverId: "ou_owner", senderId: "ou_owner",
    trusted: true, chatType: "p2p", messageType: "text", senderType: "user", direction: "inbound",
    originalText: "跟示例同事说：你好", recipient: "示例同事", text: "你好",
    contact: { identities: ["示例同事", "ou_colleague"], active: true, internal: true, unique: true }
  }), true);
  assert.equal(ownerMessageAllowed({ ...ordinary, originalText: "跟示例同事说：示例城市带的", text: "示例城市带的" }), true);
});

test("approval exemption fails closed outside the exact owner, recipient and ordinary text scope", () => {
  for (const override of [
    { enabled: false }, { senderId: "ou_other" }, { approverId: "ou_new_owner" }, { trusted: false },
    { chatType: "group" }, { messageType: "post" }, { senderType: "bot" }, { direction: "outbound" },
    { originalText: "把刚才的话转告他" }, { originalText: "有人说：跟示例同事说：你好" },
    { originalText: "不要跟示例同事说：你好" }, { recipient: "示例用户" }, { text: "hello" },
    { contact: { ...ordinary.contact, active: false } }, { contact: { ...ordinary.contact, internal: false } },
    { contact: { ...ordinary.contact, unique: false } },
    ...["密码是123456", "合同签了", "我的工资是10000", "秘密带的", "hello，付款1000元", "请帮我调查他的家庭情况", "今天接到医院诊断", "test\n秘密", "API key: test", "http://private.example", "我接受这个报价"].map((text) => ({ text, originalText: `跟示例同事说：${text}` }))
  ]) assert.equal(ownerMessageAllowed({ ...ordinary, ...override }), false, JSON.stringify(override));
});
