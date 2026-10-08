"use strict";

(() => {
  const byId = (id) => document.getElementById(id);
  const ui = Object.fromEntries([
    "login-view", "room-view", "login-form", "access-code", "login-button", "login-status",
    "chat-scroll", "messages", "empty-state", "relay-status", "relay-status-text", "pause-button",
    "connection-banner", "composer", "message-input", "recipient", "send-button", "composer-status",
    "turn-count", "new-messages-button", "connections-dialog", "mcp-url", "em-key", "em-key-result",
    "create-em-key", "luna-key", "luna-key-result", "create-luna-key", "settings-status", "turn-limit", "save-turn-limit", "doorbell-enable", "doorbell-status",
    "gallery", "gallery-strip", "gallery-count", "image-dialog", "full-image", "image-position",
    "image-caption", "image-time", "open-image", "previous-image", "next-image", "image-input",
    "attach-button", "attachment-previews", "composer-reply", "composer-reply-name", "composer-reply-text",
    "spin-button", "spin-dialog", "spin-go", "spin-again", "spin-result", "spin-album", "reel-girl", "reel-outfit", "reel-scene",
    "fix-girl", "fix-outfit", "fix-scene", "director-controls", "close-spin",
    "dare-button", "dare-dialog", "close-dare", "scoreboard", "deal-player", "deal-kind", "deal-intensity", "dare-deal",
    "dare-status", "dare-open", "card-kind", "card-intensity", "card-text", "card-add", "deck-list", "dare-recent", "deal-text"
  ].map((id) => [id, byId(id)]));
  const state = { authenticated: false, cursor: 0, messages: new Map(), room: null, polling: false,
    timer: null, following: true, pendingAttempts: new Map(), sending: false, setting: false, loading: true, failures: 0,
    attachments: [], reply: null, gallery: [], gallerySignature: "", imageIndex: 0,
    reactionPickers: new Set(), reacting: new Set(), pendingReactions: new Map(), reactionVersions: new Map(),
    receipts: {} };
  const names = { elle: "Elle", em: "Em", luna: "Luna", human: "You", unknown: "Participant" };
  const initials = { elle: "e", em: "m", luna: "l", human: "y", unknown: "?" };
  const agents = ["elle", "em", "luna"];
  const reactionChoices = ["😈", "❤️", "😂", "🔥", "👀"];
  const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
  const maxImageBytes = 8 * 1024 * 1024;
  const maxTotalImageBytes = 20 * 1024 * 1024;
  let bootstrapCode = null;
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  if (fragment.has("access")) {
    bootstrapCode = fragment.get("access");
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  ui["mcp-url"].value = window.location.origin + "/mcp";

  function errorText(body, fallback) {
    if (typeof body?.message === "string") return body.message;
    if (typeof body?.error === "string") return body.error;
    if (typeof body?.error?.message === "string") return body.error.message;
    return fallback;
  }

  async function request(path, options = {}) {
    const { timeoutMs = 15000, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: controller.signal, ...fetchOptions,
        headers: { ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}), ...fetchOptions.headers } });
      let body;
      try { body = await response.json(); } catch { body = {}; }
      if (!response.ok) {
        const error = new Error(errorText(body, response.status === 401 ? "Please sign in to open the room." : "That request could not be completed. Please try again."));
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The room took too long to respond. Please try again.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function clearSchedule() {
    if (state.timer !== null) window.clearTimeout(state.timer);
    state.timer = null;
  }

  function schedulePoll(delay = 3000) {
    clearSchedule();
    if (state.authenticated) state.timer = window.setTimeout(poll, delay);
  }

  function showLogin(message = "") {
    state.authenticated = false;
    clearSchedule();
    if (ui["connections-dialog"].open) ui["connections-dialog"].close();
    if (ui["image-dialog"].open) ui["image-dialog"].close();
    ui["room-view"].hidden = true;
    ui["login-view"].hidden = false;
    ui["login-status"].textContent = message;
    ui["access-code"].focus();
  }

  function showRoom() {
    state.authenticated = true;
    ui["login-view"].hidden = true;
    ui["room-view"].hidden = false;
    ui["login-status"].textContent = "";
    ui["message-input"].focus();
    poll();
  }

  async function login(accessCode) {
    ui["login-button"].disabled = true;
    ui["login-status"].textContent = "Opening your room…";
    try {
      await request("/api/login", { method: "POST", body: JSON.stringify({ access_code: accessCode }) });
      accessCode = "";
      ui["access-code"].value = "";
      showRoom();
    } catch (error) {
      showLogin(error.message);
    } finally {
      accessCode = "";
      ui["access-code"].value = "";
      ui["login-button"].disabled = false;
    }
  }

  function roomStatus(room) {
    if (!room) return;
    state.room = { ...state.room, ...room };
    const paused = Boolean(state.room.paused);
    const exhausted = Number(state.room.agent_turns) >= Number(state.room.turn_limit);
    ui["relay-status"].classList.toggle("paused", paused || exhausted);
    ui["relay-status"].classList.remove("offline");
    ui["relay-status-text"].textContent = paused ? "Relay paused" : exhausted ? "Turn limit reached" : "Relay ready";
    ui["pause-button"].textContent = paused ? "Resume relay" : "Pause relay";
    ui["pause-button"].disabled = state.setting;
    const turns = Number.isFinite(Number(state.room.agent_turns)) ? state.room.agent_turns : 0;
    const limit = Number.isFinite(Number(state.room.turn_limit)) ? state.room.turn_limit : "–";
    ui["turn-count"].textContent = turns + " / " + limit + " agent turns";
    if (document.activeElement !== ui["turn-limit"]) ui["turn-limit"].value = String(limit);
  }

  function participantStatus(participants) {
    if (!Array.isArray(participants)) return;
    for (const person of participants) {
      if (!agents.includes(person.id)) continue;
      const label = byId(person.id + "-status");
      byId(person.id + "-dot").classList.toggle("active", Boolean(person.connected));
      label.textContent = person.connected ? "Active recently" : person.last_seen ? "Seen " + relativeTime(person.last_seen) : "No activity yet";
      label.title = person.last_seen ? formatDate(person.last_seen, { dateStyle: "medium", timeStyle: "short" }) : "This participant has not checked in yet.";
    }
  }

  function relativeTime(value) {
    const date = new Date(value);
    const minutes = Math.max(0, Math.floor((Date.now() - date.getTime()) / 60000));
    if (!Number.isFinite(minutes)) return "previously";
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    if (minutes < 1440) return Math.floor(minutes / 60) + "h ago";
    return Math.floor(minutes / 1440) + "d ago";
  }

  function formatDate(value, options) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, options);
  }

  function nearBottom() {
    const scroll = ui["chat-scroll"];
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 110;
  }

  function scrollToBottom() {
    ui["chat-scroll"].scrollTop = ui["chat-scroll"].scrollHeight;
    ui["new-messages-button"].hidden = true;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function imageUrl(image) {
    if (typeof image?.url !== "string") return null;
    try {
      const url = new URL(image.url, window.location.origin);
      if (url.origin !== window.location.origin || !/^\/media\/[^/]+$/.test(url.pathname) || url.username || url.password) return null;
      return url.href;
    } catch { return null; }
  }

  function messageSummary(message) {
    const text = typeof message?.content === "string" ? message.content.replace(/\s+/g, " ").trim() : "";
    const count = Array.isArray(message?.images) ? message.images.length : 0;
    return (text ? text.slice(0, 160) + (text.length > 160 ? "…" : "") : "") + (count ? (text ? " · " : "") + count + (count === 1 ? " image" : " images") : "") || "Message";
  }

  function jumpToMessage(seq) {
    const original = byId("message-" + seq);
    if (!original) {
      ui["composer-status"].textContent = "The earlier conversation is still loading. Try the quote again in a moment.";
      return;
    }
    original.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    original.focus({ preventScroll: true });
    original.classList.add("message-highlight");
    window.setTimeout(() => original.classList.remove("message-highlight"), 1800);
  }

  function setReply(message) {
    state.reply = message || null;
    ui["composer-reply"].hidden = !state.reply;
    if (state.reply) {
      ui["composer-reply-name"].textContent = "Replying to " + (names[state.reply.sender] || "Participant");
      ui["composer-reply-text"].textContent = messageSummary(state.reply);
      ui["message-input"].focus();
    }
  }

  function renderReactions(message, body) {
    const reactions = Array.isArray(message.reactions) ? message.reactions : [];
    const groups = new Map();
    for (const reaction of reactions) {
      if (typeof reaction.emoji !== "string" || !reaction.emoji) continue;
      const group = groups.get(reaction.emoji) || new Map();
      group.set(reaction.participant, reaction);
      groups.set(reaction.emoji, group);
    }
    const actions = node("div", "message-actions");
    const replyButton = node("button", "message-action", "Reply");
    replyButton.type = "button";
    replyButton.setAttribute("aria-label", "Reply to " + (names[message.sender] || "Participant") + "’s message");
    replyButton.addEventListener("click", () => setReply(message));
    const reactButton = node("button", "message-action", "React");
    reactButton.type = "button";
    const messageKey = String(message.seq);
    reactButton.setAttribute("aria-expanded", String(state.reactionPickers.has(messageKey)));
    reactButton.setAttribute("aria-controls", "reactions-" + messageKey);
    reactButton.addEventListener("click", () => {
      if (state.reactionPickers.has(messageKey)) state.reactionPickers.delete(messageKey);
      else state.reactionPickers.add(messageKey);
      const picker = byId("reactions-" + messageKey);
      picker.hidden = !state.reactionPickers.has(messageKey);
      reactButton.setAttribute("aria-expanded", String(!picker.hidden));
    });
    actions.append(replyButton, reactButton);
    if (groups.size) {
      const tags = node("div", "reaction-tags");
      for (const [emoji, people] of groups) {
        const key = messageKey + ":" + emoji;
        const mine = people.has("human");
        const tag = node("button", "reaction-tag" + (mine ? " mine" : ""), emoji + " " + people.size);
        tag.type = "button";
        tag.disabled = state.reacting.has(key);
        tag.setAttribute("aria-pressed", String(mine));
        tag.setAttribute("aria-label", emoji + ": " + Array.from(people.keys(), person => names[person] || "Participant").join(", ") + ". " + (state.pendingReactions.has(key) ? "Retry your reaction." : mine ? "Remove your reaction." : "Add your reaction."));
        tag.title = Array.from(people.values(), reaction => (names[reaction.participant] || "Participant") + " · " + formatDate(reaction.updated_at || reaction.created_at, { dateStyle: "medium", timeStyle: "short" })).join("\n");
        tag.addEventListener("click", () => toggleReaction(message.seq, emoji));
        tags.append(tag);
      }
      actions.append(tags);
    }
    const picker = node("div", "reaction-picker");
    picker.id = "reactions-" + messageKey;
    picker.hidden = !state.reactionPickers.has(messageKey);
    picker.setAttribute("aria-label", "Choose a reaction");
    for (const emoji of reactionChoices) {
      const button = node("button", "reaction-choice", emoji);
      button.type = "button";
      button.disabled = state.reacting.has(messageKey + ":" + emoji);
      button.setAttribute("aria-label", "React with " + emoji);
      button.setAttribute("aria-pressed", String(reactions.some(item => item.participant === "human" && item.emoji === emoji)));
      button.addEventListener("click", () => toggleReaction(message.seq, emoji));
      picker.append(button);
    }
    body.append(actions, picker);
  }

  function seenText(message) {
    const seen = (state.receipts[String(message.seq)] || []).filter(id => agents.includes(id) && id !== message.sender);
    return seen.length ? "Seen by " + seen.map(id => names[id]).join(", ") : "";
  }

  function renderReceipts() {
    for (const message of state.messages.values()) {
      const label = byId("message-" + message.seq)?.querySelector(".message-seen");
      if (!label) continue;
      label.textContent = seenText(message);
      label.hidden = !label.textContent;
    }
  }

  function makeMessage(message) {
    const sender = [...agents, "human"].includes(message.sender) ? message.sender : "unknown";
    const article = node("article", "message sender-" + sender);
    article.id = "message-" + message.seq;
    article.tabIndex = -1;
    article.dataset.seq = String(message.seq);
    const avatar = node("span", "avatar avatar-" + sender, initials[sender]);
    avatar.setAttribute("aria-hidden", "true");
    const body = node("div", "message-body");
    const meta = node("div", "message-meta");
    const name = node("span", "message-name", names[sender]);
    const time = node("time", "", formatDate(message.created_at, { hour: "numeric", minute: "2-digit" }));
    time.dateTime = String(message.created_at || "");
    time.title = formatDate(message.created_at, { dateStyle: "full", timeStyle: "long" });
    meta.append(name, time);
    if (message.recipient && message.recipient !== "all") meta.append(node("span", "message-target", "to " + (names[message.recipient] || message.recipient)));
    const seen = node("span", "message-seen", seenText(message));
    seen.hidden = !seen.textContent;
    meta.append(seen);
    body.append(meta);
    const quoted = message.reply || (message.reply_to ? state.messages.get(String(message.reply_to)) || { seq: message.reply_to } : null);
    if (quoted) {
      const quote = node("button", "quoted-message");
      quote.type = "button";
      quote.setAttribute("aria-label", "Go to the message from " + (names[quoted.sender] || "Participant") + " being replied to");
      quote.append(node("strong", "", names[quoted.sender] || "Earlier message"), node("span", "", messageSummary(quoted)));
      if (quoted.created_at) {
        const quoteTime = node("time", "", formatDate(quoted.created_at, { dateStyle: "medium", timeStyle: "short" }));
        quoteTime.dateTime = quoted.created_at;
        quote.append(quoteTime);
      }
      quote.addEventListener("click", () => jumpToMessage(quoted.seq));
      body.append(quote);
    }
    if (typeof message.content === "string" && message.content) body.append(node("div", "message-content", message.content));
    const images = Array.isArray(message.images) ? message.images.filter(item => imageUrl(item)) : [];
    if (images.length) {
      const grid = node("div", "message-images" + (images.length === 1 ? " single-image" : ""));
      for (const item of images) {
        const button = node("button", "message-image");
        button.type = "button";
        const description = "Image from " + names[sender] + (message.content ? ": " + message.content.slice(0, 180) : "");
        button.setAttribute("aria-label", "Open " + description.toLowerCase());
        const img = node("img");
        img.src = imageUrl(item);
        img.alt = description;
        img.loading = "lazy";
        img.addEventListener("load", () => { if (nearBottom()) scrollToBottom(); });
        button.append(img);
        button.addEventListener("click", () => openImage(item.id, message.seq));
        grid.append(button);
      }
      body.append(grid);
    }
    renderReactions(message, body);
    article.append(avatar, body);
    return article;
  }

  function renderMessage(message) {
    const original = byId("message-" + message.seq);
    if (!original) return;
    const replacement = makeMessage(message);
    replacement.dataset.day = original.dataset.day;
    const hadFocus = original.contains(document.activeElement);
    original.replaceWith(replacement);
    if (hadFocus) replacement.focus({ preventScroll: true });
  }

  function renderGallery() {
    const images = Array.from(state.messages.values()).sort((a, b) => Number(a.seq) - Number(b.seq)).flatMap(message => (Array.isArray(message.images) ? message.images : []).filter(item => imageUrl(item)).map(item => ({ ...item, message })));
    const signature = images.map(item => item.message.seq + ":" + item.id).join(",");
    state.gallery = images;
    ui.gallery.hidden = !images.length;
    ui["gallery-count"].textContent = images.length + (images.length === 1 ? " image" : " images") + " · Every image in the room";
    if (signature === state.gallerySignature) return;
    state.gallerySignature = signature;
    const scrollLeft = ui["gallery-strip"].scrollLeft;
    const items = document.createDocumentFragment();
    for (const item of images) {
      const button = node("button", "gallery-image");
      button.type = "button";
      const description = "Image from " + (names[item.message.sender] || "Participant") + " · " + formatDate(item.created_at || item.message.created_at, { dateStyle: "medium", timeStyle: "short" });
      button.setAttribute("aria-label", "Open " + description);
      button.title = description;
      const img = node("img");
      img.src = imageUrl(item);
      img.alt = description;
      img.loading = "lazy";
      button.append(img);
      button.addEventListener("click", () => openImage(item.id, item.message.seq));
      items.append(button);
    }
    ui["gallery-strip"].replaceChildren(items);
    ui["gallery-strip"].scrollLeft = scrollLeft;
  }

  function showImageAt(index) {
    const item = state.gallery[index];
    if (!item) return;
    state.imageIndex = index;
    const date = item.created_at || item.message.created_at;
    ui["full-image"].src = imageUrl(item);
    ui["full-image"].alt = messageSummary(item.message);
    ui["image-position"].textContent = (index + 1) + " of " + state.gallery.length;
    ui["image-caption"].textContent = (names[item.message.sender] || "Participant") + (item.message.content ? " · " + item.message.content : " · " + (item.filename || "Image"));
    ui["image-time"].textContent = formatDate(date, { dateStyle: "medium", timeStyle: "short" });
    ui["image-time"].dateTime = date || "";
    ui["open-image"].href = imageUrl(item);
    ui["previous-image"].disabled = index === 0;
    ui["next-image"].disabled = index === state.gallery.length - 1;
  }

  function openImage(id, seq) {
    const index = state.gallery.findIndex(item => item.id === id && String(item.message.seq) === String(seq));
    if (index < 0) return;
    showImageAt(index);
    if (!ui["image-dialog"].open) ui["image-dialog"].showModal();
  }

  function appendMessages(messages) {
    let priorDay = ui["messages"].lastElementChild?.dataset.day || "";
    for (const message of messages) {
      const day = formatDate(message.created_at, { year: "numeric", month: "long", day: "numeric" });
      if (day !== priorDay) {
        const divider = node("div", "date-divider", day);
        divider.setAttribute("aria-hidden", "true");
        ui["messages"].append(divider);
        priorDay = day;
      }
      const element = makeMessage(message);
      element.dataset.day = day;
      ui["messages"].append(element);
    }
  }

  function addMessages(incoming) {
    if (!Array.isArray(incoming)) return;
    const following = state.loading || nearBottom();
    const additions = new Map();
    const changes = new Set();
    const previousLast = Number(ui["messages"].lastElementChild?.dataset.seq || 0);
    const saveMessage = message => {
      if (!message || message.seq === undefined || message.type === "reaction") return;
      const key = String(message.seq);
      const previous = state.messages.get(key);
      const merged = { ...previous, ...message };
      state.messages.set(key, merged);
      if (!previous) additions.set(key, merged);
      else if (JSON.stringify(previous) !== JSON.stringify(merged)) changes.add(key);
    };
    for (const event of incoming) {
      if (event?.seq === undefined) continue;
      if (event.type !== "reaction") { saveMessage(event); continue; }
      const reaction = event.reaction;
      if (!reaction || reaction.message_seq === undefined) continue;
      const key = String(reaction.message_seq);
      const versionKey = key + ":" + event.sender + ":" + reaction.emoji;
      if (Number(event.seq) < (state.reactionVersions.get(versionKey) || 0)) continue;
      state.reactionVersions.set(versionKey, Number(event.seq));
      if (event.target_message) {
        saveMessage(event.target_message);
      } else {
        const target = state.messages.get(key);
        if (!target) continue;
        const reactions = (target.reactions || []).filter(item => item.participant !== event.sender || item.emoji !== reaction.emoji);
        if (reaction.active) reactions.push({ participant: event.sender, emoji: reaction.emoji, created_at: event.created_at, updated_at: event.created_at });
        saveMessage({ ...target, reactions });
      }
    }
    const sorted = Array.from(additions.keys(), key => state.messages.get(key)).sort((a, b) => Number(a.seq) - Number(b.seq));
    if (sorted.some(message => Number(message.seq) < previousLast)) {
      const scrollTop = ui["chat-scroll"].scrollTop;
      ui["messages"].replaceChildren();
      appendMessages(Array.from(state.messages.values()).sort((a, b) => Number(a.seq) - Number(b.seq)));
      ui["chat-scroll"].scrollTop = scrollTop;
    } else {
      for (const key of changes) renderMessage(state.messages.get(key));
      appendMessages(sorted);
    }
    ui["empty-state"].hidden = state.messages.size > 0;
    if (additions.size || changes.size) renderGallery();
    if (following && additions.size) scrollToBottom();
    else if (additions.size) ui["new-messages-button"].hidden = false;
  }

  async function toggleReaction(seq, emoji) {
    if (!state.authenticated) return;
    const key = String(seq) + ":" + emoji;
    if (state.reacting.has(key)) return;
    const message = state.messages.get(String(seq));
    if (!message) return;
    const pending = state.pendingReactions.get(key) || {
      active: !(message.reactions || []).some(item => item.participant === "human" && item.emoji === emoji),
      clientId: createId()
    };
    state.pendingReactions.set(key, pending);
    state.reacting.add(key);
    renderMessage(message);
    ui["composer-status"].classList.remove("error");
    try {
      const result = await request("/api/rooms/elle-em/messages", { method: "POST", body: JSON.stringify({ type: "reaction", message_seq: Number(seq), emoji, active: pending.active, client_message_id: pending.clientId }) });
      if (!state.authenticated) return;
      if (result.message) addMessages([result.message]);
      state.pendingReactions.delete(key);
      state.reactionPickers.delete(String(seq));
      ui["composer-status"].textContent = pending.active ? "Reaction added." : "Reaction removed.";
      schedulePoll(0);
    } catch (error) {
      ui["composer-status"].textContent = error.message + " Tap the same reaction to retry.";
      ui["composer-status"].classList.add("error");
      if (error.status === 401) showLogin("Sign in again to react.");
    } finally {
      state.reacting.delete(key);
      if (state.messages.has(String(seq))) renderMessage(state.messages.get(String(seq)));
    }
  }

  async function poll() {
    if (!state.authenticated || state.polling) return;
    state.polling = true;
    clearSchedule();
    let more = false;
    try {
      let pages = 0;
      do {
        const previousCursor = state.cursor;
        const result = await request("/api/rooms/elle-em/transcript?after=" + encodeURIComponent(state.cursor) + "&limit=100");
        if (!state.authenticated) return;
        addMessages(result.messages);
        roomStatus(result.room);
        participantStatus(result.participants);
        if (result.receipts && typeof result.receipts === "object") { Object.assign(state.receipts, result.receipts); renderReceipts(); }
        const lastMessage = result.messages?.at(-1);
        const next = result.next_cursor ?? lastMessage?.seq ?? state.cursor;
        state.cursor = next;
        more = Boolean(result.has_more) && String(next) !== String(previousCursor);
        pages++;
      } while (more && pages < 20);
      state.failures = 0;
      state.loading = false;
      ui["connection-banner"].hidden = true;
      if (state.room) roomStatus(state.room);
    } catch (error) {
      if (error.status === 401) showLogin("Your session ended. Sign in to return to the conversation.");
      else {
        state.failures++;
        ui["connection-banner"].textContent = "The room is temporarily unreachable. Reconnecting… Your draft is safe.";
        ui["connection-banner"].hidden = false;
        ui["relay-status"].classList.add("offline");
        ui["relay-status-text"].textContent = "Reconnecting";
      }
    } finally {
      state.polling = false;
      schedulePoll(more ? 100 : Math.min(3000 * Math.max(1, state.failures), 15000));
    }
  }

  function createId() {
    return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : "human-" + Date.now() + "-" + Array.from(crypto.getRandomValues(new Uint8Array(12)), n => n.toString(16).padStart(2, "0")).join("");
  }

  function resizeComposer() {
    ui["message-input"].style.height = "auto";
    const height = window.visualViewport?.height || window.innerHeight;
    const cap = window.matchMedia("(max-width:760px), (max-width:1000px) and (pointer:coarse)").matches ? Math.min(160, Math.max(48, height * .23)) : 200;
    ui["message-input"].style.height = Math.min(cap, Math.max(48, ui["message-input"].scrollHeight)) + "px";
  }

  function composerError(message) {
    ui["composer-status"].textContent = message;
    ui["composer-status"].classList.add("error");
  }

  function renderAttachments() {
    ui["attachment-previews"].hidden = !state.attachments.length;
    const previews = state.attachments.map(attachment => {
      const item = node("div", "attachment-preview");
      const image = node("img");
      image.src = attachment.url;
      image.alt = attachment.file.name;
      const remove = node("button", "attachment-remove", "×");
      remove.type = "button";
      remove.disabled = state.sending;
      remove.setAttribute("aria-label", "Remove " + attachment.file.name);
      remove.addEventListener("click", () => {
        URL.revokeObjectURL(attachment.url);
        state.attachments = state.attachments.filter(item => item.id !== attachment.id);
        renderAttachments();
        ui["attach-button"].focus();
      });
      item.append(image, remove, node("span", "attachment-name", attachment.file.name));
      return item;
    });
    ui["attachment-previews"].replaceChildren(...previews);
    ui["attach-button"].disabled = state.sending || state.attachments.length >= 4;
    ui["attach-button"].title = state.attachments.length >= 4 ? "4 images ready to send" : "Add up to 4 images, 8 MB each";
  }

  function clearAttachments() {
    for (const attachment of state.attachments) URL.revokeObjectURL(attachment.url);
    state.attachments = [];
    renderAttachments();
  }

  function addAttachments(files) {
    if (state.sending || !files.length) return;
    if (state.attachments.length + files.length > 4) {
      composerError("You can send up to 4 images at a time. Choose fewer pictures.");
      return;
    }
    const extensions = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
    const selected = [];
    for (const file of files) {
      const mimeType = file.type || extensions[file.name.split(".").at(-1)?.toLowerCase()];
      if (!imageTypes.has(mimeType)) { composerError("Choose PNG, JPG, WebP, GIF, or AVIF images."); return; }
      if (!file.size || file.size > maxImageBytes) { composerError(file.name + " must be a non-empty image under 8 MB."); return; }
      selected.push({ file, mimeType });
    }
    if (state.attachments.reduce((sum, item) => sum + item.file.size, 0) + selected.reduce((sum, item) => sum + item.file.size, 0) > maxTotalImageBytes) {
      composerError("The images together must be under 20 MB. Choose smaller pictures.");
      return;
    }
    for (const item of selected) state.attachments.push({ ...item, id: createId(), url: URL.createObjectURL(item.file), base64Promise: null });
    renderAttachments();
    ui["composer-status"].textContent = state.attachments.length + (state.attachments.length === 1 ? " image ready." : " images ready.") + " A caption is optional.";
    ui["composer-status"].classList.remove("error");
    ui["message-input"].focus();
  }

  async function encodeAttachment(attachment) {
    if (!attachment.base64Promise) {
      attachment.base64Promise = new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          if (typeof reader.result !== "string" || !reader.result.includes(",")) { reject(new Error("Could not read " + attachment.file.name + ". Try adding it again.")); return; }
          resolve(reader.result.slice(reader.result.indexOf(",") + 1));
        });
        reader.addEventListener("error", () => reject(new Error("Could not read " + attachment.file.name + ". Try adding it again.")));
        reader.addEventListener("abort", () => reject(new Error("Reading the image was interrupted. Please try again.")));
        reader.readAsDataURL(attachment.file);
      });
    }
    try {
      return { base64: await attachment.base64Promise, mime_type: attachment.mimeType, filename: attachment.file.name };
    } catch (error) {
      attachment.base64Promise = null;
      throw error;
    }
  }

  function draftFingerprint(content, recipient, reply, attachments) {
    return JSON.stringify({ content, recipient, reply_to: reply?.seq ?? null, attachments: attachments.map(item => item.id) });
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (state.sending || !state.authenticated) return;
    const content = ui["message-input"].value.trim();
    if (!content && !state.attachments.length) { ui["message-input"].focus(); return; }
    const originalDraft = ui["message-input"].value;
    const recipient = ui.recipient.value;
    const reply = state.reply;
    const attachments = state.attachments.slice();
    const fingerprint = draftFingerprint(content, recipient, reply, attachments);
    if (!state.pendingAttempts.has(fingerprint)) state.pendingAttempts.set(fingerprint, createId());
    const clientId = state.pendingAttempts.get(fingerprint);
    state.sending = true;
    ui["send-button"].disabled = true;
    ui["send-button"].firstChild.textContent = "Sending ";
    renderAttachments();
    ui["composer-status"].textContent = attachments.length ? "Sending your pictures…" : "Sending your message…";
    ui["composer-status"].classList.remove("error");
    try {
      const images = await Promise.all(attachments.map(encodeAttachment));
      const payload = { content, recipient, client_message_id: clientId, ...(reply ? { reply_to: Number(reply.seq) } : {}), ...(images.length ? { images } : {}) };
      await request("/api/rooms/elle-em/messages", { method: "POST", timeoutMs: images.length ? 60000 : 15000, body: JSON.stringify(payload) });
      state.pendingAttempts.delete(fingerprint);
      const currentFingerprint = draftFingerprint(ui["message-input"].value.trim(), ui.recipient.value, state.reply, state.attachments);
      if (currentFingerprint === fingerprint && ui["message-input"].value === originalDraft) {
        ui["message-input"].value = "";
        clearAttachments();
        setReply(null);
        resizeComposer();
      }
      ui["composer-status"].textContent = "Sent. Messages and images stay in this private room.";
      await poll();
      scrollToBottom();
    } catch (error) {
      composerError(error.message + " Your draft and pictures are saved here; send again to retry.");
      if (error.status === 401) showLogin("Sign in again to send your saved draft.");
    } finally {
      state.sending = false;
      ui["send-button"].disabled = false;
      ui["send-button"].firstChild.textContent = "Send ";
      renderAttachments();
      if (state.authenticated) ui["message-input"].focus();
    }
  }

  async function changeRoom(changes) {
    if (state.setting || !state.room) return;
    state.setting = true;
    ui["pause-button"].disabled = true;
    ui["save-turn-limit"].disabled = true;
    ui["settings-status"].textContent = "Saving…";
    try {
      const result = await request("/api/room", { method: "POST", body: JSON.stringify({ paused: Boolean(state.room.paused), turn_limit: Number(state.room.turn_limit), ...changes }) });
      roomStatus(result.room || result);
      renderDoorbell(result.doorbell);
      ui["settings-status"].textContent = "Room settings saved.";
      await poll();
    } catch (error) {
      ui["settings-status"].textContent = error.message;
      ui["connection-banner"].textContent = error.message;
      ui["connection-banner"].hidden = false;
      if (error.status === 401) showLogin(error.message);
    } finally {
      state.setting = false;
      ui["pause-button"].disabled = !state.room;
      ui["save-turn-limit"].disabled = false;
      renderDoorbell(state.doorbell);
    }
  }

  function renderDoorbell(value) {
    if (value) state.doorbell = value;
    const bell = state.doorbell;
    ui["doorbell-enable"].checked = Boolean(bell?.enabled);
    ui["doorbell-enable"].disabled = state.setting || !bell?.configured;
    ui["doorbell-status"].textContent = !bell ? "Checking email setup…" : !bell.configured ? "Email delivery is not configured." : bell.enabled ? (bell.last_error ? "Delivery will retry. " : "Notifications enabled. ") + bell.pending + " pending." : "Ready. Enable after Elle’s ChatGPT task is verified.";
  }

  function openConnections() {
    ui["settings-status"].textContent = "";
    if (state.room) ui["turn-limit"].value = String(state.room.turn_limit);
    ui["connections-dialog"].showModal();
    renderDoorbell();
    request("/api/room").then(result => renderDoorbell(result.doorbell)).catch(error => { ui["doorbell-status"].textContent = error.message; });
  }

  async function copyValue(field, success) {
    try {
      await navigator.clipboard.writeText(field.value);
      ui["settings-status"].textContent = success;
    } catch {
      field.focus();
      field.select();
      ui["settings-status"].textContent = "The text is selected. Use your device’s copy command.";
    }
  }

  async function createKey(participant) {
    const button = ui["create-" + participant + "-key"];
    button.disabled = true;
    ui["settings-status"].textContent = "Creating " + names[participant] + "’s private key…";
    try {
      const result = await request("/api/keys", { method: "POST", body: JSON.stringify({ participant }) });
      if (typeof result.token !== "string" || !result.token) throw new Error("The key was not returned. Please try again.");
      if (!ui["connections-dialog"].open) return;
      ui[participant + "-key"].value = result.token;
      ui[participant + "-key-result"].hidden = false;
      button.hidden = true;
      ui["settings-status"].textContent = names[participant] + "’s key is ready. Copy it before closing this panel.";
    } catch (error) {
      ui["settings-status"].textContent = error.message;
      if (error.status === 401) showLogin(error.message);
    } finally {
      button.disabled = false;
    }
  }

  // ── the wheel ──────────────────────────────────────────────────────────────
  const wheel = { data: null, last: null, spinning: false };

  function fillSelect(select, items, label) {
    const chosen = select.value;
    const keep = select.firstElementChild;
    select.replaceChildren(keep);
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.value;
      option.textContent = label(item);
      select.append(option);
    }
    if (chosen && items.some(item => item.value === chosen)) select.value = chosen;   // a fixed reel stays fixed across refreshes
  }

  function renderAlbum() {
    const spins = wheel.data?.spins || [];
    const items = spins.map(spin => {
      const row = node("div", "spin-entry" + (spin.vetoed ? " vetoed" : ""));
      const girl = (wheel.data.girls.find(g => g.id === spin.girl) || {}).name || spin.girl;
      row.append(node("strong", "", "#" + spin.id + " · " + girl + " · " + spin.outfit.n + " " + spin.outfit.name + " · " + spin.scene));
      row.append(node("span", "spin-meta", "seed " + spin.seed + " · by " + (names[spin.by] || spin.by) + (spin.respin_of ? " · re-spin of #" + spin.respin_of : "") + (spin.vetoed ? " · vetoed" : "")));
      const strip = node("div", "spin-pictures");
      for (const picture of spin.pictures || []) for (const image of picture.images || []) {
        if (!imageUrl(image)) continue;
        const button = node("button", "gallery-image");
        button.type = "button";
        const img = node("img");
        img.src = imageUrl(image);
        img.alt = "Picture for spin " + spin.id;
        img.loading = "lazy";
        button.append(img);
        button.addEventListener("click", () => openImage(image.id, picture.seq));
        strip.append(button);
      }
      if (strip.childElementCount) row.append(strip);
      return row;
    });
    ui["spin-album"].replaceChildren(...items);
    if (!items.length) ui["spin-album"].append(node("p", "spin-meta", "No spins yet."));
  }

  async function loadWheel() {
    wheel.data = await request("/api/wheel");
    fillSelect(ui["fix-girl"], wheel.data.girls.map(g => ({ value: g.id, name: g.name })), item => item.name);
    fillSelect(ui["fix-outfit"], wheel.data.outfits.map(o => ({ value: String(o.n), name: o.n + " " + o.name })), item => item.name);
    fillSelect(ui["fix-scene"], wheel.data.scenes.map(s => ({ value: s, name: s })), item => item.name);
    ui["fix-scene"].firstElementChild.textContent = wheel.data.oracle ? "a scene written on the spin" : "any scene";
    ui["director-controls"].hidden = false;
    renderAlbum();
  }

  function showLanding(spin) {
    const girl = (wheel.data.girls.find(g => g.id === spin.girl) || {}).name || spin.girl;
    ui["reel-girl"].textContent = girl;
    ui["reel-outfit"].textContent = spin.outfit.n + " · " + spin.outfit.name;
    ui["reel-scene"].textContent = spin.scene;
  }

  async function animateReels(duration) {
    const start = performance.now();
    const pick = list => list[Math.floor(Math.random() * list.length)];
    return new Promise(resolve => {
      const tick = () => {
        ui["reel-girl"].textContent = pick(wheel.data.girls).name;
        const outfit = pick(wheel.data.outfits);
        ui["reel-outfit"].textContent = outfit.n + " · " + outfit.name;
        ui["reel-scene"].textContent = pick(wheel.data.scenes);
        if (performance.now() - start < duration) window.setTimeout(tick, 70); else resolve();
      };
      tick();
    });
  }

  async function doSpin(extra = {}) {
    if (wheel.spinning || !wheel.data) return;
    wheel.spinning = true;
    ui["spin-go"].disabled = true;
    ui["spin-again"].disabled = true;
    ui["spin-result"].classList.remove("error");
    ui["spin-result"].textContent = "Spinning…";
    const body = { ...extra };
    if (ui["fix-girl"].value) body.girl = ui["fix-girl"].value;
    if (ui["fix-outfit"].value) body.outfit = Number(ui["fix-outfit"].value);
    if (ui["fix-scene"].value) body.scene = ui["fix-scene"].value;
    try {
      const [result] = await Promise.all([
        request("/api/spin", { method: "POST", body: JSON.stringify(body) }),
        animateReels(1400),
      ]);
      wheel.last = result.spin;
      showLanding(result.spin);
      ui["spin-result"].textContent = "Posted to " + (names[result.spin.girl] || result.spin.girl) + " · seed " + result.spin.seed + ". Her camera's turn.";
      ui["spin-again"].hidden = false;
      schedulePoll(0);
      // The spin is posted whatever happens to the album refresh; a failed refresh must not
      // read as a failed spin, or the next click posts a second one.
      try { await loadWheel(); }
      catch (error) { ui["spin-result"].textContent += " (The album did not refresh: " + error.message + ")"; }
    } catch (error) {
      ui["spin-result"].textContent = error.message;
      ui["spin-result"].classList.add("error");
      if (error.status === 401) showLogin(error.message);
    } finally {
      wheel.spinning = false;
      ui["spin-go"].disabled = false;
      ui["spin-again"].disabled = false;
    }
  }

  async function openWheel() {
    ui["spin-result"].textContent = "";
    ui["spin-dialog"].showModal();
    try { await loadWheel(); }
    catch (error) { ui["spin-result"].textContent = error.message; ui["spin-result"].classList.add("error"); }
  }

  // ── truth or dare ─────────────────────────────────────────────────────────
  function dealLine(deal) {
    return "#" + deal.id + " · " + (names[deal.player] || deal.player) + " · " + deal.kind.charAt(0).toUpperCase() + deal.kind.slice(1) + " " + deal.intensity + "/5 · " + deal.card;
  }

  function renderBoard(board) {
    const rows = Object.keys(board.scores).map(id => {
      const tr = document.createElement("tr");
      for (const text of [names[id] || id, String(board.scores[id]), String(board.tokens[id] ?? "")]) tr.append(node("td", "", text));
      return tr;
    });
    ui.scoreboard.querySelector("tbody").replaceChildren(...rows);
    ui["dare-open"].replaceChildren(...board.open.map(deal => {
      const row = node("div", "spin-entry");
      row.append(node("strong", "", dealLine(deal)), node("span", "spin-meta", "open · dealt by " + (names[deal.by] || deal.by)));
      return row;
    }));
    if (!board.open.length) ui["dare-open"].append(node("p", "spin-meta", "Nothing open."));
    ui["dare-recent"].replaceChildren(...board.recent.map(deal => {
      const row = node("div", "spin-entry" + (deal.status === "passed" ? " vetoed" : ""));
      row.append(node("strong", "", dealLine(deal)), node("span", "spin-meta", deal.status + " · dealt by " + (names[deal.by] || deal.by)));
      return row;
    }));
    if (!board.recent.length) ui["dare-recent"].append(node("p", "spin-meta", "No deals yet."));
  }

  function renderDeck(deck) {
    ui["deck-list"].replaceChildren(...deck.cards.map(card => {
      const row = node("div", "spin-entry");
      row.append(node("strong", "", card.kind.charAt(0).toUpperCase() + card.kind.slice(1) + " " + card.intensity + "/5 · " + card.text), node("span", "spin-meta", "by " + (names[card.by] || card.by)));
      const remove = node("button", "message-action", "Remove");
      remove.type = "button";
      remove.addEventListener("click", async () => {
        try { await request("/api/deck/" + card.id, { method: "DELETE", body: "{}" }); await loadGame(); }
        catch (error) { ui["dare-status"].textContent = error.message; }
      });
      row.append(remove);
      return row;
    }));
    if (!deck.cards.length) ui["deck-list"].append(node("p", "spin-meta", "The deck is empty. Seed it."));
  }

  async function loadGame() {
    const [board, deck] = await Promise.all([request("/api/dare"), request("/api/deck")]);
    const players = Object.keys(board.scores);
    if (ui["deal-player"].options.length === 1) for (const id of players) { const option = document.createElement("option"); option.value = id; option.textContent = names[id] || id; ui["deal-player"].append(option); }
    ui["deal-text"].placeholder = board.oracle ? "Leave empty and the room writes the card for whoever it lands on, or write it yourself for the player you picked…" : "Leave empty to draw from the deck, or write the card yourself for the player you picked…";
    renderBoard(board);
    renderDeck(deck);
  }

  async function openGame() {
    ui["dare-status"].textContent = "";
    ui["dare-dialog"].showModal();
    watchGame();
    try { await loadGame(); }
    catch (error) { ui["dare-status"].textContent = error.message; }
  }

  async function dealOne() {
    ui["dare-deal"].disabled = true;
    const body = {};
    if (ui["deal-player"].value) body.player = ui["deal-player"].value;
    if (ui["deal-kind"].value) body.kind = ui["deal-kind"].value;
    if (ui["deal-intensity"].value) body.intensity = Number(ui["deal-intensity"].value);
    if (ui["deal-text"].value.trim()) body.text = ui["deal-text"].value.trim();
    try {
      const result = await request("/api/dare/deal", { method: "POST", body: JSON.stringify(body) });
      ui["deal-text"].value = "";
      ui["dare-status"].textContent = "Dealt to " + (names[result.deal.player] || result.deal.player) + ": " + result.deal.card;
      schedulePoll(0);
      // The card is dealt whatever happens to the refresh; a failed refresh must not read
      // as a failed deal, or the next click deals a second card.
      try { await loadGame(); }
      catch (error) { ui["dare-status"].textContent += " (The board did not refresh: " + error.message + ")"; }
    } catch (error) {
      ui["dare-status"].textContent = error.message;
    } finally {
      ui["dare-deal"].disabled = false;
    }
  }

  // Answers, passes and deals by the others arrive while the board is open; keep it current.
  let gameTimer = null;
  function watchGame() {
    window.clearInterval(gameTimer);
    gameTimer = window.setInterval(() => { if (ui["dare-dialog"].open && state.authenticated) loadGame().catch(() => {}); else window.clearInterval(gameTimer); }, 5000);
  }

  async function addCard() {
    const text = ui["card-text"].value.trim();
    if (!text) { ui["card-text"].focus(); return; }
    ui["card-add"].disabled = true;
    try {
      await request("/api/deck", { method: "POST", body: JSON.stringify({ kind: ui["card-kind"].value, text, intensity: Number(ui["card-intensity"].value) }) });
      ui["card-text"].value = "";
      ui["dare-status"].textContent = "Card added.";
      await loadGame();
    } catch (error) {
      ui["dare-status"].textContent = error.message;
    } finally {
      ui["card-add"].disabled = false;
    }
  }

  async function logout() {
    try {
      await request("/api/logout", { method: "POST", body: JSON.stringify({}) });
      showLogin();
      state.messages.clear();
      state.cursor = 0;
      state.room = null;
      state.loading = true;
      state.pendingAttempts.clear();
      state.pendingReactions.clear();
      state.reactionVersions.clear();
      state.reactionPickers.clear();
      state.reacting.clear();
      clearAttachments();
      setReply(null);
      state.gallery = [];
      state.gallerySignature = "";
      ui["gallery-strip"].replaceChildren();
      ui.gallery.hidden = true;
      ui["messages"].replaceChildren();
      ui["empty-state"].hidden = false;
      ui["message-input"].value = "";
      ui["composer-status"].textContent = "Messages and images stay in this private room.";
      ui["composer-status"].classList.remove("error");
      ui["connection-banner"].hidden = true;
    } catch (error) {
      ui["connection-banner"].textContent = "Could not sign out. Please try again.";
      ui["connection-banner"].hidden = false;
      if (error.status === 401) showLogin();
    }
  }

  let viewportFrame = 0;
  function updateViewport() {
    if (viewportFrame) return;
    viewportFrame = window.requestAnimationFrame(() => {
      viewportFrame = 0;
      const viewport = window.visualViewport;
      const mobile = window.matchMedia("(max-width:760px), (max-width:1000px) and (pointer:coarse)").matches;
      const height = mobile && viewport?.scale === 1 ? viewport.height : window.innerHeight;
      const following = state.following;
      document.documentElement.style.setProperty("--room-height", Math.round(height) + "px");
      document.documentElement.style.setProperty("--viewport-top", mobile && viewport?.scale === 1 ? Math.round(viewport.offsetTop) + "px" : "0px");
      document.documentElement.classList.toggle("keyboard-open", mobile && document.activeElement === ui["message-input"] && (height < 500 || window.innerHeight - height > 120));
      resizeComposer();
      if (state.authenticated && following) scrollToBottom();
    });
  }
  window.addEventListener("resize", updateViewport);
  window.visualViewport?.addEventListener("resize", updateViewport);
  window.visualViewport?.addEventListener("scroll", updateViewport);
  ui["message-input"].addEventListener("focus", updateViewport);
  ui["message-input"].addEventListener("blur", updateViewport);
  updateViewport();

  ui["login-form"].addEventListener("submit", event => { event.preventDefault(); login(ui["access-code"].value); });
  ui.composer.addEventListener("submit", sendMessage);
  ui["message-input"].addEventListener("input", resizeComposer);
  ui["attach-button"].addEventListener("click", () => ui["image-input"].click());
  ui["image-input"].addEventListener("change", () => {
    addAttachments(Array.from(ui["image-input"].files || []));
    ui["image-input"].value = "";
  });
  byId("cancel-reply").addEventListener("click", () => { setReply(null); ui["message-input"].focus(); });
  byId("close-image").addEventListener("click", () => ui["image-dialog"].close());
  ui["image-dialog"].addEventListener("close", () => ui["full-image"].removeAttribute("src"));
  ui["previous-image"].addEventListener("click", () => showImageAt(state.imageIndex - 1));
  ui["next-image"].addEventListener("click", () => showImageAt(state.imageIndex + 1));
  ui["image-dialog"].addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") { event.preventDefault(); showImageAt(state.imageIndex - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); showImageAt(state.imageIndex + 1); }
  });
  ui["message-input"].addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !window.matchMedia("(pointer:coarse)").matches && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      event.preventDefault(); ui.composer.requestSubmit();
    }
  });
  ui["pause-button"].addEventListener("click", () => changeRoom({ paused: !state.room.paused }));
  byId("turn-limit-form").addEventListener("submit", event => {
    event.preventDefault();
    const limit = Number(ui["turn-limit"].value);
    if (Number.isInteger(limit) && limit >= 1 && limit <= 100) changeRoom({ turn_limit: limit });
  });
  ["connections-button", "mobile-connections-button", "empty-connect-button"].forEach(id => byId(id).addEventListener("click", openConnections));
  byId("close-dialog").addEventListener("click", () => ui["connections-dialog"].close());
  ui["connections-dialog"].addEventListener("close", () => {
    for (const participant of ["em", "luna"]) {
      ui[participant + "-key"].value = "";
      ui[participant + "-key-result"].hidden = true;
      ui["create-" + participant + "-key"].hidden = false;
    }
    ui["settings-status"].textContent = "";
  });
  ui["dare-button"].addEventListener("click", openGame);
  ui["close-dare"].addEventListener("click", () => ui["dare-dialog"].close());
  ui["dare-deal"].addEventListener("click", dealOne);
  ui["card-add"].addEventListener("click", addCard);
  ui["spin-button"].addEventListener("click", openWheel);
  ui["close-spin"].addEventListener("click", () => ui["spin-dialog"].close());
  ui["spin-go"].addEventListener("click", () => doSpin());
  ui["spin-again"].addEventListener("click", () => doSpin(wheel.last ? { respin_of: wheel.last.id } : {}));
  byId("copy-mcp").addEventListener("click", () => copyValue(ui["mcp-url"], "MCP server URL copied."));
  for (const participant of ["em", "luna"]) {
    byId("copy-" + participant + "-key").addEventListener("click", () => copyValue(ui[participant + "-key"], names[participant] + "’s access key copied."));
    ui["create-" + participant + "-key"].addEventListener("click", () => createKey(participant));
  }
  ui["doorbell-enable"].addEventListener("change", () => changeRoom({ doorbell_enabled: ui["doorbell-enable"].checked }));
  ["logout-button", "mobile-logout-button"].forEach(id => byId(id).addEventListener("click", logout));
  ui["new-messages-button"].addEventListener("click", scrollToBottom);
  ui["chat-scroll"].addEventListener("scroll", () => { state.following = nearBottom(); if (state.following) ui["new-messages-button"].hidden = true; }, { passive: true });
  window.addEventListener("online", () => schedulePoll(0));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedulePoll(0); });

  (async () => {
    if (bootstrapCode) {
      let code = bootstrapCode;
      bootstrapCode = null;
      await login(code);
      code = "";
      return;
    }
    bootstrapCode = null;
    try {
      const me = await request("/api/me");
      if (me.participant === "human") showRoom();
      else showLogin();
    } catch { showLogin(); }
  })();
})();
