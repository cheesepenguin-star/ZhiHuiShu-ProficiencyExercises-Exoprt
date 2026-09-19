// ==UserScript==
// @name         智慧树掌握度题目导出器
// @namespace    codex.local.zhihuishu.mastery.exporter
// @version      1.0.0
// @description  按知识点区间导出掌握度练习中当前账号可见的题干、选项、公式和图片；不答题、不保存、不提交、不读取 Cookie。
// @match        https://studywisdomh5.zhihuishu.com/study*
// @match        https://studywisdomh5.zhihuishu.com/exam*
// @match        https://studywisdomh5.zhihuishu.com/pointOfMastery*
// @match        https://wisdom-mooc.zhihuishu.com/study*
// @match        https://wisdom-mooc.zhihuishu.com/exam*
// @match        https://wisdom-mooc.zhihuishu.com/pointOfMastery*
// @match        https://*.zhihuishu.com/study*
// @match        https://*.zhihuishu.com/exam*
// @match        https://*.zhihuishu.com/pointOfMastery*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'zhs_question_exporter_state_v5';
  const SCRIPT_VERSION = 5;
  const UI_ID = '__zhs_mastery_exporter__';
  const MAX_TARGETS = 1000;
  const EXPECTED_QUESTIONS_PER_TARGET = 5;
  const EXPECTED_QUESTION_NUMBERS = ['1', '2', '3', '4', '5'];
  const WAIT_MS = 12000;
  const STEP_DELAY_MS = 900;

  const TAB_NAME_MARKER = '__zhs_mastery_exporter_tab__=';
  const tabNameMatch = String(window.name || '').match(/(?:^|\|)__zhs_mastery_exporter_tab__=([^|]+)/);
  const TAB_ID = tabNameMatch?.[1] || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  if (!tabNameMatch) window.name = `${window.name ? `${window.name}|` : ''}${TAB_NAME_MARKER}${TAB_ID}`;

  const ROUTE = {
    mastery: () => /\/study\/mastery(?:[/?#]|$)/.test(location.href),
    practice: () => /\/exam(?:[/?#]|$)/.test(location.href),
    result: () => /\/pointOfMastery(?:[/?#]|$)/.test(location.href)
  };

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const norm = value => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const cleanName = value => norm(value).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
  const isVisible = el => !!(el && el.nodeType === 1 && el.getClientRects().length &&
    getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
  const absoluteUrl = value => {
    try { return new URL(value, location.href).href; } catch { return String(value || ''); }
  };
  const hash = input => {
    let h = 2166136261;
    for (const ch of String(input)) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
    return (h >>> 0).toString(36);
  };
  const nowIso = () => new Date().toISOString();
  const displayIdFor = (targetIndex, questionNumber) =>
    `${String(targetIndex || 0).padStart(3, '0')}-${String(questionNumber || '')}`;

  function emptyState() {
    return {
      version: SCRIPT_VERSION,
      active: false,
      phase: 'idle',
      ownerTabId: '',
      courseKey: '',
      courseTitle: '',
      masteryUrl: '',
      startedAt: '',
      completedAt: '',
      exportedAt: '',
      cursor: 0,
      rangeStart: 1,
      rangeEnd: 0,
      rangeConfigured: false,
      questionsPerTarget: EXPECTED_QUESTIONS_PER_TARGET,
      declaredTargetCount: 0,
      targets: [],
      currentTarget: null,
      completedTargetKeys: [],
      questions: [],
      failures: [],
      log: []
    };
  }

  function loadState() {
    const value = GM_getValue(STORAGE_KEY, null);
    if (!value || value.version !== SCRIPT_VERSION) return emptyState();
    return { ...emptyState(), ...value };
  }

  let state = loadState();
  let working = false;
  let cancelEpoch = 0;
  let routerTimer = 0;
  let lastUrl = location.href;
  let ui = null;

  function masteryRangeBounds() {
    const total = state.targets.length;
    const start = Math.min(Math.max(Number(state.rangeStart) || 1, 1), Math.max(total, 1));
    const end = Math.min(Math.max(Number(state.rangeEnd) || total || 1, start), Math.max(total, 1));
    return {
      start,
      end,
      startIndex: start - 1,
      endExclusive: end,
      count: total ? end - start + 1 : 0
    };
  }

  function validateRange(startValue, endValue, total = state.targets.length) {
    const startText = String(startValue ?? '').trim();
    const endText = String(endValue ?? '').trim();
    if (!/^\d+$/.test(startText) || !/^\d+$/.test(endText)) {
      return { valid: false, message: '起始和结束序号必须是整数' };
    }
    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { valid: false, message: '知识点序号无效' };
    }
    if (!Number.isSafeInteger(total) || total < 1) {
      return { valid: false, message: '请先识别知识点' };
    }
    if (start < 1 || end < 1) {
      return { valid: false, message: '知识点序号必须从 1 开始' };
    }
    if (start > end) {
      return { valid: false, message: '起始序号不能大于结束序号' };
    }
    if (end > total) {
      return { valid: false, message: `结束序号不能超过 ${total}` };
    }
    return {
      valid: true,
      start,
      end,
      startIndex: start - 1,
      endExclusive: end,
      count: end - start + 1
    };
  }

  function scopedTargets() {
    if (!state.rangeConfigured) return [];
    const bounds = masteryRangeBounds();
    return state.targets.slice(bounds.startIndex, bounds.endExclusive);
  }

  function masteryRunEndExclusive() {
    return state.rangeConfigured ? masteryRangeBounds().endExclusive : 0;
  }

  function selectedRangeProgress() {
    const bounds = masteryRangeBounds();
    return {
      processed: state.rangeConfigured
        ? Math.min(Math.max(state.cursor - bounds.startIndex, 0), bounds.count)
        : 0,
      total: state.rangeConfigured ? bounds.count : state.targets.length
    };
  }

  function saveState() {
    GM_setValue(STORAGE_KEY, state);
    renderUi();
  }

  function addLog(message) {
    const line = `${new Date().toLocaleTimeString()} ${message}`;
    state.log = [...(state.log || []), line].slice(-18);
    console.info(`[智慧树题目导出] ${message}`);
    saveState();
  }

  function courseKeyFromUrl(url = location.href) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('recruitAndCourseId') ||
        parsed.searchParams.get('courseId') || parsed.pathname;
    } catch {
      return location.pathname;
    }
  }

  function explicitCourseParam(url = location.href) {
    try {
      const parsed = new URL(url);
      return parsed.searchParams.get('recruitAndCourseId') || parsed.searchParams.get('courseId') || '';
    } catch {
      return '';
    }
  }

  function textOf(el) {
    return norm(el?.innerText || el?.textContent || '');
  }

  function dispatchClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch { /* no-op */ }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }

  function activateTargetTrigger(el) {
    if (!el) return;
    for (const type of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter']) {
      try {
        el.dispatchEvent(new Event(type, {
          bubbles: type.endsWith('over'),
          cancelable: true
        }));
      } catch { /* no-op */ }
    }
    dispatchClick(el);
  }

  async function waitFor(check, timeout = WAIT_MS, interval = 180) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const result = check();
        if (result) return result;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    if (lastError) console.debug('[智慧树题目导出] waitFor last error', lastError);
    return null;
  }

  function knowledgeName(item) {
    return textOf(item.querySelector('.item-box-name_text')) ||
      textOf(item.querySelector('.item-box-name')) || textOf(item).slice(0, 180) || '未命名知识点';
  }

  function itemStableId(item) {
    const keys = ['data-id', 'data-point-id', 'data-knowledge-id', 'data-node-id'];
    for (const key of keys) {
      const value = item.getAttribute(key);
      if (value) return `${key}:${value}`;
    }
    return '';
  }

  function declaredTargetCountFromPage() {
    const labels = [...document.querySelectorAll('body *')]
      .filter(element => /知识点总数/.test(textOf(element)))
      .sort((left, right) => textOf(left).length - textOf(right).length);
    for (const label of labels) {
      let container = label;
      for (let depth = 0; depth < 5 && container; depth += 1) {
        const value = textOf(container);
        const match = value.match(/(\d{1,4})\s*知识点总数/) ||
          value.match(/知识点总数\D{0,12}(\d{1,4})/);
        const count = Number(match?.[1]);
        if (count > 0 && count <= MAX_TARGETS) return count;
        container = container.parentElement;
      }
    }
    return 0;
  }

  function sectionTitleForItem(item) {
    const selector = [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong',
      '[class*="chapter-title"]', '[class*="section-title"]',
      '[class*="group-title"]', '[class*="category-title"]',
      '[class*="module-title"]', '[class*="chapter-name"]',
      '[class*="section-name"]', '[class*="group-name"]',
      '[class$="-title"]', '[class$="_title"]'
    ].join(',');
    const ignored = /^(基本信息|掌握度热力图|本课程和知识点我的情况对比|AI助教总结)$/;
    const usable = element => {
      if (!element || element.closest('.item-box') || element.closest(`#${UI_ID}`)) return '';
      const value = textOf(element);
      if (!value || value.length > 80 || ignored.test(value) || /提升掌握度|去提升/.test(value)) return '';
      return value;
    };

    let branch = item;
    for (let depth = 0; depth < 7 && branch?.parentElement; depth += 1) {
      let sibling = branch.previousElementSibling;
      while (sibling) {
        const candidates = [];
        if (sibling.matches?.(selector)) candidates.push(sibling);
        candidates.push(...sibling.querySelectorAll(selector));
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          const value = usable(candidates[index]);
          if (value) return value;
        }
        sibling = sibling.previousElementSibling;
      }
      branch = branch.parentElement;
    }
    return '';
  }

  async function discoverTargets() {
    const collected = new Map();
    const declaredCount = declaredTargetCountFromPage();
    const seenNameCount = new Map();
    let unchanged = 0;
    let previousSize = -1;

    window.scrollTo({ top: 0, behavior: 'auto' });
    for (let step = 0; step < 80; step += 1) {
      const items = [...document.querySelectorAll('.item-box')];
      seenNameCount.clear();
      items.forEach((item, index) => {
        const name = knowledgeName(item);
        const normalized = cleanName(name) || `item${index + 1}`;
        const occurrence = (seenNameCount.get(normalized) || 0) + 1;
        seenNameCount.set(normalized, occurrence);
        const stableId = itemStableId(item);
        const key = stableId || `${normalized}#${occurrence}`;
        if (!collected.has(key)) {
          collected.set(key, {
            key,
            name,
            sectionTitle: sectionTitleForItem(item),
            normalized,
            occurrence,
            initialIndex: index,
            className: item.className
          });
        }
      });

      if (collected.size === previousSize) unchanged += 1;
      else unchanged = 0;
      previousSize = collected.size;

      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 8;
      if (atBottom && declaredCount && collected.size >= declaredCount && unchanged >= 2) break;
      if (atBottom && !declaredCount && unchanged >= 6) break;
      window.scrollBy({ top: Math.max(360, window.innerHeight * 0.8), behavior: 'auto' });
      await sleep(260);
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    const targets = [...collected.values()].slice(0, MAX_TARGETS);
    let sectionIndex = 0;
    let previousSection = '';
    return targets.map((target, index) => {
      if (target.sectionTitle && target.sectionTitle !== previousSection) sectionIndex += 1;
      if (target.sectionTitle) previousSection = target.sectionTitle;
      return {
        ...target,
        targetIndex: index + 1,
        sectionIndex: target.sectionTitle ? sectionIndex : 0
      };
    });
  }

  function findTargetElement(target) {
    const items = [...document.querySelectorAll('.item-box')];
    if (target.key.includes(':')) {
      const exact = items.find(item => itemStableId(item) === target.key);
      if (exact) return exact;
    }
    const sameName = items.filter(item => cleanName(knowledgeName(item)) === target.normalized);
    return sameName[target.occurrence - 1] ||
      (items[target.initialIndex] && cleanName(knowledgeName(items[target.initialIndex])) === target.normalized
        ? items[target.initialIndex] : null);
  }

  function visiblePopovers() {
    return [...document.querySelectorAll(
      '.el-popover, .el-popper, .mastery-box-custom-popover, .custom-content'
    )].filter(isVisible);
  }

  function allPopoverContainers() {
    return [...document.querySelectorAll(
      '.el-popover, .el-popper, .mastery-box-custom-popover, .custom-content'
    )];
  }

  function namedPreRenderedButtonFor(target) {
    const targetName = target.normalized;
    const buttons = new Set();
    for (const popover of allPopoverContainers()) {
      const nameEls = [...popover.querySelectorAll(
        '.name, strong.name, .item-box-name_text, .item-box-name, strong'
      )];
      const names = nameEls.map(el => cleanName(textOf(el))).filter(Boolean);
      const nameMatches = names.some(name => name === targetName ||
        name.endsWith(targetName) || targetName.endsWith(name) ||
        (targetName.length >= 8 && name.includes(targetName)));
      if (!nameMatches) continue;
      for (const button of popover.querySelectorAll('.el-button, button, [role="button"], a')) {
        if (/提升掌握度|去提升/.test(textOf(button))) buttons.add(button);
      }
    }
    return buttons.size === 1 ? [...buttons][0] : null;
  }

  function popoverButtonFor(target, visibleBefore = new Set()) {
    const targetName = target.normalized;
    const candidates = [];
    for (const popover of visiblePopovers()) {
      const nameEl = popover.querySelector('.name, strong.name, .item-box-name_text, strong');
      const popoverName = cleanName(textOf(nameEl));
      const nameMatches = !!popoverName && (!targetName || popoverName === targetName ||
        popoverName.includes(targetName.slice(-20)) || targetName.includes(popoverName.slice(-20)));
      for (const button of popover.querySelectorAll('.el-button, button, [role="button"]')) {
        if (/^(提升掌握度|去提升)$/.test(textOf(button)) && isVisible(button)) {
          candidates.push({ button, popover, nameMatches, isNew: !visibleBefore.has(popover) });
        }
      }
    }
    const named = candidates.filter(candidate => candidate.nameMatches);
    if (named.length === 1) return named[0].button;
    const newlyVisible = candidates.filter(candidate => candidate.isNew);
    if (newlyVisible.length === 1) return newlyVisible[0].button;
    return null;
  }

  async function openCurrentTarget(epoch) {
    if (!state.active || epoch !== cancelEpoch || !ROUTE.mastery()) return;
    const bounds = masteryRangeBounds();
    if (state.rangeConfigured && state.cursor < bounds.startIndex) state.cursor = bounds.startIndex;
    if (state.cursor >= masteryRunEndExclusive()) return finishRun();

    const target = state.targets[state.cursor];
    state.currentTarget = target;
    state.phase = 'opening';
    saveState();

    let item = findTargetElement(target);
    if (!item) {
      window.scrollTo({ top: 0, behavior: 'auto' });
      item = await waitFor(() => findTargetElement(target), 5000);
    }
    if (!state.active || epoch !== cancelEpoch) return;
    if (!item) return skipCurrent('回到掌握度页后找不到该知识点', epoch);

    item.scrollIntoView({ block: 'center', behavior: 'auto' });
    await sleep(300);

    const trigger = item.querySelector('.item-box-name, .el-tooltip__trigger') || item;
    if ((trigger.closest('.item-box') || trigger) !== item) {
      return skipCurrent('知识点点击目标不属于当前卡片', epoch);
    }
    const beforePopovers = new Set(visiblePopovers());
    activateTargetTrigger(trigger);
    let button = await waitFor(() => popoverButtonFor(target, beforePopovers), 3000);
    button ||= namedPreRenderedButtonFor(target);
    if (!state.active || epoch !== cancelEpoch) return;
    if (!button) {
      activateTargetTrigger(trigger);
      button = await waitFor(() => popoverButtonFor(target, beforePopovers), 2500);
      button ||= namedPreRenderedButtonFor(target);
    }
    if (!state.active || epoch !== cancelEpoch) return;
    if (!button) return skipCurrent('未找到“提升掌握度/去提升”按钮（可能没有练习）', epoch);

    const popover = button.closest('.el-popover, .el-popper, .mastery-box-custom-popover, .custom-content');
    if (!popover || !/提升掌握度|去提升/.test(textOf(button))) {
      return skipCurrent('练习入口未通过只读导航安全检查', epoch);
    }
    if (button.matches('a[target="_blank"]')) button.setAttribute('target', '_self');

    state.phase = 'awaiting-practice';
    saveState();
    addLog(`进入知识点 ${state.cursor + 1}/${state.targets.length}（区间 ${bounds.start}-${bounds.end}）：${target.name}`);
    dispatchClick(button);

    const changed = await waitFor(() => ROUTE.practice(), 9000);
    if (!state.active || epoch !== cancelEpoch) return;
    if (!changed) {
      // Some versions may open the exercise in a new tab. If that tab has already
      // taken over the shared userscript state, leave this mastery tab idle so the
      // two tabs do not advance the cursor at the same time.
      const shared = loadState();
      if (shared.currentTarget?.key === target.key && shared.ownerTabId !== TAB_ID &&
          ['awaiting-practice', 'scraping', 'returning'].includes(shared.phase)) {
        state = shared;
        renderUi();
        return;
      }
      return skipCurrent('点击练习入口后页面没有变化', epoch);
    }
    scheduleRouter(200);
  }

  function visibleQuestionContainer() {
    const examItems = [...document.querySelectorAll('.exam-item')];
    const visibleExam = examItems.find(isVisible);
    return visibleExam?.querySelector('.question-item') ||
      [...document.querySelectorAll('.question-item')].find(isVisible) || null;
  }

  function renderedQuestionKey(container) {
    if (!container) return '';
    const stem = container.querySelector('.quest-title .option-name, .quest-title');
    const options = [...container.querySelectorAll('.preStyle, .el-radio__label, .el-checkbox__label')]
      .map(textOf).join('\n');
    return hash(`${textOf(stem)}\n${options}`);
  }

  function sanitizedHtml(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,iframe,object,embed').forEach(node => node.remove());
    clone.querySelectorAll('*').forEach(node => {
      for (const attribute of [...node.attributes]) {
        if (/^on/i.test(attribute.name) || attribute.name === 'srcdoc') node.removeAttribute(attribute.name);
      }
      if (node.matches('img')) {
        const src = node.currentSrc || node.getAttribute('src') || node.dataset.src ||
          node.dataset.original || node.dataset.lazySrc;
        if (src) node.setAttribute('src', absoluteUrl(src));
        node.removeAttribute('srcset');
      }
      if (node.matches('a[href]')) node.setAttribute('href', absoluteUrl(node.getAttribute('href')));
    });
    return clone.innerHTML.trim();
  }

  function portableText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('script:not([type^="math/tex"]),style,noscript').forEach(node => node.remove());

    for (const node of clone.querySelectorAll('.katex, mjx-container, math, script[type^="math/tex"]')) {
      if (!clone.contains(node)) continue;
      const annotation = node.querySelector?.('annotation[encoding="application/x-tex"]');
      const tex = norm(annotation?.textContent || node.dataset?.tex || node.getAttribute?.('aria-label') ||
        (node.matches?.('script[type^="math/tex"]') ? node.textContent : ''));
      if (tex) node.replaceWith(document.createTextNode(`$${tex}$`));
    }
    for (const img of clone.querySelectorAll('img')) {
      const src = absoluteUrl(img.currentSrc || img.getAttribute('src') || img.dataset.src ||
        img.dataset.original || img.dataset.lazySrc || '');
      const label = norm(img.getAttribute('alt') || img.getAttribute('title') || '图片');
      img.replaceWith(document.createTextNode(src ? `![${label}](${src})` : `[${label}]`));
    }
    clone.querySelectorAll('br').forEach(br => br.replaceWith(document.createTextNode('\n')));
    return norm(clone.textContent);
  }

  function imageUrls(el) {
    if (!el) return [];
    return [...new Set([...el.querySelectorAll('img')].map(img => absoluteUrl(
      img.currentSrc || img.getAttribute('src') || img.dataset.src || img.dataset.original ||
      img.dataset.lazySrc || ''
    )).filter(Boolean))];
  }

  function normalizeOption(value, fallbackLabel = '') {
    let text = norm(value);
    const detected = text.match(/^\s*(?:[（(【\[]\s*)?([A-Z])\s*[.．、:：)）\]】\-—|｜]\s*/i);
    const fallback = String(fallbackLabel || '').trim().toUpperCase();
    const label = fallback || String(detected?.[1] || '').toUpperCase();
    if (label) {
      const decoratedSource = `(?:[（(【\\[]\\s*)?${label}\\s*[.．、:：)）\\]】\\-—|｜]`;
      const decoratedPrefix = new RegExp(`^\\s*${decoratedSource}\\s*`, 'i');
      const bareDuplicatePrefix = new RegExp(`^\\s*${label}\\s+(?=${decoratedSource})`, 'i');
      for (let pass = 0; pass < 8 && text; pass += 1) {
        const decoratedMatch = text.match(decoratedPrefix);
        if (decoratedMatch) {
          text = norm(text.slice(decoratedMatch[0].length));
          continue;
        }
        const bareMatch = text.match(bareDuplicatePrefix);
        if (bareMatch) {
          text = norm(text.slice(bareMatch[0].length));
          continue;
        }
        break;
      }
    }
    return { label, text };
  }

  function normalizedOptionRecord(option, index = 0) {
    const fallbackLabel = String(option?.label || String.fromCharCode(65 + index)).toUpperCase();
    const normalized = normalizeOption(option?.text || '', fallbackLabel);
    return {
      ...option,
      label: normalized.label || fallbackLabel,
      text: normalized.text
    };
  }

  function optionFromElement(optionEl, index, contentSelector) {
    const fallbackLabel = String.fromCharCode(65 + index);
    const labelEl = optionEl.querySelector('.mr10, .option-index, .option-label, [class*="option-label"]');
    const labelMatch = textOf(labelEl).match(/\b([A-Z])\b/i);
    const content = optionEl.querySelector(contentSelector) || optionEl;
    const normalized = normalizeOption(portableText(content), labelMatch?.[1] || fallbackLabel);
    return {
      label: normalized.label || fallbackLabel,
      text: normalized.text,
      html: sanitizedHtml(content),
      images: imageUrls(content)
    };
  }

  function extractQuestion(questionContainer, questionNumber, target) {
    const typeEl = questionContainer.querySelector('.quest-type');
    const stemEl = questionContainer.querySelector('.quest-title .option-name') ||
      questionContainer.querySelector('.quest-title') || questionContainer;
    let optionEls = [...questionContainer.querySelectorAll('.el-radio, .el-checkbox')];
    if (!optionEls.length) optionEls = [...questionContainer.querySelectorAll('.option-item, [class*="option-item"]')];

    const options = optionEls.map((optionEl, index) => optionFromElement(
      optionEl,
      index,
      '.preStyle, .el-radio__label, .el-checkbox__label, .option-name'
    ));
    const stem = portableText(stemEl);
    const questionIdNode = questionContainer.closest('[data-question-id],[data-topic-id],[data-id]') ||
      questionContainer.querySelector('[data-question-id],[data-topic-id],[data-id]');
    const questionId = questionIdNode?.getAttribute('data-question-id') ||
      questionIdNode?.getAttribute('data-topic-id') || questionIdNode?.getAttribute('data-id') || '';
    const contentFingerprint = questionId ? `id:${questionId}` :
      `hash:${hash(`${stem}\n${options.map(option => option.text).join('\n')}`)}`;
    const targetIndex = Number(target?.targetIndex) || state.cursor + 1;
    const targetKey = target?.key || `target-${targetIndex}`;
    const instanceKey = `${targetKey}::slot:${questionNumber}`;

    return {
      fingerprint: instanceKey,
      instanceKey,
      contentFingerprint,
      questionId,
      targetKey,
      targetIndex,
      targetTitle: target?.name || '未知知识点',
      sectionIndex: Number(target?.sectionIndex) || 0,
      sectionTitle: target?.sectionTitle || '',
      groupQuestionNumber: Number(questionNumber) || questionNumber,
      displayId: displayIdFor(targetIndex, questionNumber),
      knowledgePoints: [target?.name || '未知知识点'],
      questionNumber,
      type: textOf(typeEl) || (textOf(questionContainer).match(/单选题|多选题|判断题|填空题|简答题|计算题/) || [''])[0],
      stem,
      stemHtml: sanitizedHtml(stemEl),
      options,
      images: [...new Set([...imageUrls(stemEl), ...options.flatMap(option => option.images)])],
      sourceUrl: location.href,
      capturedAt: nowIso()
    };
  }

  function mergeQuestion(question) {
    const index = state.questions.findIndex(item =>
      (item.instanceKey || item.fingerprint) === question.instanceKey
    );
    if (index < 0) {
      state.questions.push({ ...question, firstCapturedAt: question.capturedAt });
      return true;
    }
    const old = state.questions[index];
    state.questions[index] = {
      ...old,
      ...question,
      firstCapturedAt: old.firstCapturedAt || old.capturedAt || question.capturedAt
    };
    return false;
  }

  function visibleAnswerCardItems() {
    const groups = [...document.querySelectorAll('.answer-card')]
      .filter(isVisible)
      .map(card => [...card.querySelectorAll('.list .item')]
        .filter(item => isVisible(item) && /^\d+$/.test(textOf(item))))
      .filter(items => items.length)
      .sort((left, right) => right.length - left.length);
    return groups[0] || [];
  }

  function canScrapeCurrentPractice() {
    return state.active && !!state.currentTarget &&
      ['awaiting-practice', 'scraping'].includes(state.phase);
  }

  function canTakePracticeOwnership() {
    if (!state.active || !ROUTE.practice() || state.phase !== 'awaiting-practice' || !state.currentTarget ||
        state.ownerTabId === TAB_ID) return false;
    const currentParam = explicitCourseParam();
    if (currentParam && currentParam !== state.courseKey) return false;
    const referrer = String(document.referrer || '');
    const matchingReferrer = /\/study\/mastery(?:[/?#]|$)/.test(referrer) &&
      courseKeyFromUrl(referrer) === state.courseKey;
    return !!window.opener || matchingReferrer;
  }

  async function scrapePractice(epoch) {
    if (!state.active || epoch !== cancelEpoch || !ROUTE.practice()) return;
    if (!canScrapeCurrentPractice()) {
      state.active = false;
      state.phase = 'paused';
      addLog('当前练习页不是由本轮掌握度任务打开，已暂停以避免误采集');
      return;
    }
    if (!state.currentTarget) return failPractice('缺少当前知识点定位信息', epoch);
    state.phase = 'scraping';
    saveState();

    let lastCardSignature = '';
    let stableCardRounds = 0;
    let lastObservedCardCount = 0;
    const cards = await waitFor(() => {
      const list = visibleAnswerCardItems();
      lastObservedCardCount = list.length;
      if (list.length < EXPECTED_QUESTIONS_PER_TARGET) return null;
      const signature = list.map(textOf).join('|');
      stableCardRounds = signature === lastCardSignature ? stableCardRounds + 1 : 0;
      lastCardSignature = signature;
      return stableCardRounds >= 4 ? list : null;
    });
    if (!state.active || epoch !== cancelEpoch) return;
    if (!cards) {
      return failPractice(`答题卡未完整加载：应有 ${EXPECTED_QUESTIONS_PER_TARGET} 题，当前只看到 ${lastObservedCardCount} 题`, epoch);
    }
    if (cards.length !== EXPECTED_QUESTIONS_PER_TARGET) {
      return failPractice(`答题卡题数异常：应有 ${EXPECTED_QUESTIONS_PER_TARGET} 题，实际看到 ${cards.length} 题`, epoch);
    }

    const targetKey = state.currentTarget?.key || '';
    const storedTarget = state.targets.find(target => target.key === targetKey);
    const expectedQuestionNumbers = cards.map((card, index) => textOf(card) || String(index + 1));
    if (expectedQuestionNumbers.join('|') !== EXPECTED_QUESTION_NUMBERS.join('|')) {
      return failPractice(`答题卡题号异常：应为 ${EXPECTED_QUESTION_NUMBERS.join('、')}，实际为 ${expectedQuestionNumbers.join('、')}`, epoch);
    }
    // Rebuild this knowledge point from the current run so an old cached slot
    // cannot hide a question that failed to load this time.
    state.questions = state.questions.filter(question => question.targetKey !== targetKey);
    if (storedTarget) {
      storedTarget.expectedQuestionCount = cards.length;
      storedTarget.expectedQuestionNumbers = expectedQuestionNumbers;
    }
    state.currentTarget.expectedQuestionCount = cards.length;
    state.currentTarget.expectedQuestionNumbers = expectedQuestionNumbers;
    state.questionsPerTarget = EXPECTED_QUESTIONS_PER_TARGET;
    saveState();

    let captured = 0;
    for (let index = 0; index < cards.length; index += 1) {
      if (!state.active) return;
      const freshCards = visibleAnswerCardItems();
      const card = freshCards[index];
      if (!card) {
        state.failures.push({
          target: state.currentTarget?.name || '',
          targetIndex: state.currentTarget?.targetIndex || state.cursor + 1,
          questionNumber: String(index + 1),
          reason: '答题卡题号在采集过程中消失',
          at: nowIso()
        });
        state.active = false;
        state.phase = 'paused';
        addLog(`已暂停：知识点 ${state.currentTarget?.targetIndex || state.cursor + 1} 的第 ${index + 1} 个答题卡项目消失`);
        return;
      }
      const number = textOf(card) || String(index + 1);
      if (!/^\d+$/.test(number)) return failPractice('答题卡项目不是纯数字，已停止以避免误点', epoch);
      const beforeContainer = visibleQuestionContainer();
      const beforeKey = renderedQuestionKey(beforeContainer);
      const wasActive = card.classList.contains('active');
      if (!wasActive) dispatchClick(card);
      const clickedAt = Date.now();
      let selectedStableKey = '';
      let selectedStableRounds = 0;

      const resolveCurrentQuestion = () => {
        const current = visibleQuestionContainer();
        if (!current) return null;
        const indexEl = current.querySelector('.quest-title .option-index');
        const renderedNumber = (textOf(indexEl).match(/\d+/) || [])[0] || '';
        if (renderedNumber && renderedNumber !== number) return null;
        const currentKey = renderedQuestionKey(current);
        if (!currentKey) return null;
        if (index === 0 && wasActive) return current;
        if (currentKey !== beforeKey) return current;
        if (renderedNumber === number) {
          if (Date.now() - clickedAt >= 1200) {
            selectedStableRounds = currentKey === selectedStableKey ? selectedStableRounds + 1 : 0;
            selectedStableKey = currentKey;
            if (selectedStableRounds >= 2) return current;
          }
        }
        return null;
      };
      let container = await waitFor(resolveCurrentQuestion, 7000);
      if (!container) {
        const retryCard = visibleAnswerCardItems()[index];
        if (retryCard) dispatchClick(retryCard);
        container = await waitFor(resolveCurrentQuestion, 5000);
      }
      if (!state.active || epoch !== cancelEpoch) return;
      if (!container) {
        state.failures.push({
          target: state.currentTarget?.name || '',
          questionNumber: number,
          reason: '题目内容加载超时',
          at: nowIso()
        });
        saveState();
        continue;
      }

      let settledKey = '';
      let settledRounds = 0;
      const settledContainer = await waitFor(() => {
        const current = visibleQuestionContainer();
        if (!current) return null;
        const renderedNumber = (textOf(current.querySelector('.quest-title .option-index')).match(/\d+/) || [])[0] || '';
        if (renderedNumber && renderedNumber !== number) return null;
        const currentKey = renderedQuestionKey(current);
        if (!currentKey) return null;
        settledRounds = currentKey === settledKey ? settledRounds + 1 : 0;
        settledKey = currentKey;
        return settledRounds >= 2 ? current : null;
      }, 2500, 120);
      if (!settledContainer) {
        state.failures.push({
          target: state.currentTarget?.name || '',
          questionNumber: number,
          reason: '题目内容未能稳定，已拒绝保存以避免题号错位',
          at: nowIso()
        });
        saveState();
        continue;
      }
      await sleep(250);
      if (!state.active || epoch !== cancelEpoch) return;
      const verifiedContainer = visibleQuestionContainer();
      const verifiedNumber = (textOf(verifiedContainer?.querySelector('.quest-title .option-index')).match(/\d+/) || [])[0] || '';
      if (!verifiedContainer || (verifiedNumber && verifiedNumber !== number) ||
          renderedQuestionKey(verifiedContainer) !== settledKey) {
        state.failures.push({
          target: state.currentTarget?.name || '',
          questionNumber: number,
          reason: '题目在保存前再次变化，已拒绝保存以避免题号错位',
          at: nowIso()
        });
        saveState();
        continue;
      }
      container = verifiedContainer;
      const question = extractQuestion(container, number, state.currentTarget);
      const choiceLike = /单选|多选|选择|判断/.test(question.type) ||
        !!container.querySelector('.el-radio, .el-checkbox');
      const usableOptions = question.options.filter(option => option.text || option.images.length);
      if (choiceLike && usableOptions.length < 2) {
        state.failures.push({
          target: state.currentTarget?.name || '',
          questionNumber: number,
          reason: '检测到选择题，但没有读取到至少两个选项',
          at: nowIso()
        });
        state.active = false;
        state.phase = 'paused';
        addLog(`已暂停：第 ${number} 题的选项未成功读取，请勿继续空跑`);
        return;
      }
      if (question.stem) {
        mergeQuestion(question);
        captured += 1;
      } else {
        state.failures.push({
          target: state.currentTarget?.name || '',
          questionNumber: number,
          reason: '题干为空',
          at: nowIso()
        });
      }
      saveState();
    }

    const targetQuestions = state.questions.filter(question => question.targetKey === targetKey);
    const savedNumbers = new Set(targetQuestions.map(question => String(question.questionNumber)));
    const missingNumbers = expectedQuestionNumbers.filter(number => !savedNumbers.has(String(number)));
    if (missingNumbers.length || targetQuestions.length !== cards.length) {
      const reason = missingNumbers.length
        ? `本组题目不完整，缺少第 ${missingNumbers.join('、')} 题`
        : `答题卡有 ${cards.length} 个题位，但只保存了 ${targetQuestions.length} 道`;
      state.failures.push({
        target: state.currentTarget?.name || '',
        targetIndex: state.currentTarget?.targetIndex || state.cursor + 1,
        reason,
        at: nowIso()
      });
      state.active = false;
      state.phase = 'paused';
      addLog(`已暂停：知识点 ${state.currentTarget?.targetIndex || state.cursor + 1} ${reason}`);
      return;
    }

    if (targetKey && !state.completedTargetKeys.includes(targetKey)) state.completedTargetKeys.push(targetKey);
    state.cursor += 1;
    state.phase = 'returning';
    addLog(`知识点 ${state.currentTarget?.targetIndex || state.cursor}/${state.targets.length}「${state.currentTarget?.name || '本组'}」：读取 ${captured}/${cards.length} 道，累计 ${state.questions.length} 道`);
    await sleep(STEP_DELAY_MS);
    if (!state.active || epoch !== cancelEpoch) return;
    location.assign(state.masteryUrl);
  }

  function recordTargetFailure(reason) {
    state.failures.push({
      target: state.currentTarget?.name || state.targets[state.cursor]?.name || '',
      reason,
      at: nowIso()
    });
  }

  async function skipCurrent(reason, epoch = cancelEpoch) {
    recordTargetFailure(reason);
    addLog(`跳过：${state.currentTarget?.name || '未知知识点'}（${reason}）`);
    state.cursor += 1;
    state.currentTarget = null;
    state.phase = 'mastery';
    const recentNavigationFailures = state.failures.slice(-5).filter(item =>
      /未找到“提升掌握度\/去提升”按钮|练习入口未通过/.test(item.reason)
    ).length;
    if (recentNavigationFailures >= 5) {
      state.active = false;
      state.phase = 'paused';
      addLog('已连续 5 次找不到练习入口，自动暂停，避免空跑整门课程');
      return;
    }
    saveState();
    await sleep(STEP_DELAY_MS);
    if (state.active && epoch === cancelEpoch) scheduleRouter(100);
  }

  async function failPractice(reason, epoch = cancelEpoch) {
    recordTargetFailure(reason);
    state.active = false;
    state.phase = 'paused';
    addLog(`已暂停，当前知识点不会跳过：${reason}`);
    await sleep(STEP_DELAY_MS);
    if (epoch === cancelEpoch && state.masteryUrl) location.assign(state.masteryUrl);
  }

  function orderedQuestions() {
    const targetKeys = new Set(scopedTargets().map(target => target.key));
    return state.questions.filter(question => targetKeys.has(question.targetKey)).sort((left, right) => {
      const targetOrder = (Number(left.targetIndex) || 0) - (Number(right.targetIndex) || 0);
      if (targetOrder) return targetOrder;
      const questionOrder = (Number(left.groupQuestionNumber ?? left.questionNumber) || 0) -
        (Number(right.groupQuestionNumber ?? right.questionNumber) || 0);
      if (questionOrder) return questionOrder;
      return String(left.displayId || '').localeCompare(String(right.displayId || ''), 'zh-CN');
    });
  }

  function collectionAudit() {
    const missing = [];
    const missingTargetKeys = new Set();
    const targets = scopedTargets();
    const questions = orderedQuestions();
    const completed = new Set(state.completedTargetKeys);
    for (const target of targets) {
      const saved = new Set(questions
        .filter(question => question.targetKey === target.key)
        .map(question => String(question.questionNumber)));
      for (const number of EXPECTED_QUESTION_NUMBERS) {
        if (!saved.has(number)) {
          missingTargetKeys.add(target.key);
          missing.push({
            targetIndex: target.targetIndex,
            targetTitle: target.name,
            questionNumber: number,
            displayId: displayIdFor(target.targetIndex, number)
          });
        }
      }
    }
    const expectedQuestionCount = targets.length * EXPECTED_QUESTIONS_PER_TARGET;
    const completedTargetCount = targets.filter(target => completed.has(target.key)).length;
    const incompleteTargetCount = targets.filter(target =>
      !completed.has(target.key) || missingTargetKeys.has(target.key)
    ).length;
    const discoveryComplete = !state.declaredTargetCount || state.targets.length === state.declaredTargetCount;
    return {
      targetCount: targets.length,
      completedTargetCount,
      incompleteTargetCount,
      expectedQuestionCount,
      actualQuestionCount: questions.length,
      missing,
      complete: state.rangeConfigured && targets.length > 0 && discoveryComplete &&
        completedTargetCount === targets.length &&
        missing.length === 0 &&
        (!expectedQuestionCount || questions.length === expectedQuestionCount)
    };
  }

  function appendQuestion(lines, question) {
    const number = question.groupQuestionNumber ?? question.questionNumber;
    lines.push(`### ${question.displayId}｜第 ${number} 题｜${question.type || '选择题'}`, '');
    lines.push(question.stem || '[题干未读取]', '');
    if (question.options?.length) {
      question.options.forEach((option, index) => {
        const normalized = normalizedOptionRecord(option, index);
        lines.push(`${normalized.label}. ${normalized.text || '[图片选项]'}`);
      });
    } else {
      lines.push('[选项未成功读取]');
    }
    lines.push('', '---', '');
  }

  function appendGroupedQuestions(lines) {
    let previousTargetKey = '';
    let previousSection = '';
    for (const question of orderedQuestions()) {
      if (question.targetKey !== previousTargetKey) {
        if (question.sectionTitle && question.sectionTitle !== previousSection) {
          lines.push(`# 分组 ${question.sectionIndex || ''}｜${question.sectionTitle}`, '');
          previousSection = question.sectionTitle;
        }
        lines.push(
          `## 知识点 ${String(question.targetIndex).padStart(3, '0')}/${state.targets.length}｜${question.targetTitle}`,
          ''
        );
        previousTargetKey = question.targetKey;
      }
      appendQuestion(lines, question);
    }
  }

  function aiMarkdownPayload() {
    const audit = collectionAudit();
    const bounds = masteryRangeBounds();
    const exampleTargetId = String(bounds.start).padStart(3, '0');
    const missingPreview = audit.missing.slice(0, 30).map(item => item.displayId).join('、');
    const lines = [
      '# 选择题作答任务',
      '',
      '只回答本文件实际列出的题目；不要补写、猜测或回答未采集的题号。',
      '请逐题判断正确选项。答案只需保留定位编号和选项字母，无需抄写题干或原选项内容。',
      '单选题和判断题只写一个字母；多选题的字母按字母顺序连续书写，例如 AC。每道题单独一行。',
      '每题前面的“定位编号”必须原样保留，并按知识点大标题分组。严格使用以下格式：',
      '',
      `## 知识点 ${exampleTargetId}/${state.targets.length}｜示例标题`,
      `${exampleTargetId}-1. A`,
      `${exampleTargetId}-2. AC`,
      `${exampleTargetId}-3. B`,
      '',
      '不要把定位编号改成连续数字；不要省略知识点标题。如果无法确定，请在该题答案后简短标注“不确定”。',
      '',
      `课程：${state.courseTitle || '智慧树课程'}`,
      `知识点范围：${bounds.start}-${bounds.end}（全课程已识别 ${state.targets.length} 个）`,
      `本文件题目：${audit.actualQuestionCount}/${audit.expectedQuestionCount}；采集状态：${audit.complete ? '完整' : '部分'}。`,
      ...(!audit.complete && missingPreview
        ? [`未采集题位：${missingPreview}${audit.missing.length > 30 ? '……' : ''}。`]
        : []),
      '',
      '---',
      ''
    ];
    appendGroupedQuestions(lines);
    return lines.join('\n');
  }

  function safeFilename(value) {
    return norm(value || '智慧树掌握度题目').replace(/[\\/:*?"<>|]/g, '_').slice(0, 70);
  }

  function canExportCurrentRun() {
    return !state.active && ['paused', 'done', 'exported'].includes(state.phase) &&
      orderedQuestions().length > 0;
  }

  function finalizeExportSession() {
    cancelEpoch += 1;
    clearTimeout(routerTimer);
    state.active = false;
    state.phase = 'exported';
    state.currentTarget = null;
    state.ownerTabId = '';
    state.completedAt ||= nowIso();
    state.exportedAt = nowIso();
    const audit = collectionAudit();
    addLog(`已导出 ${audit.actualQuestionCount} 道题，本次采集已结束；再次采集需重新识别并选择区间`);
  }

  function downloadAi() {
    if (state.active) {
      addLog('请先暂停采集，再导出当前成果');
      return;
    }
    if (!canExportCurrentRun()) {
      addLog('当前还没有可导出的题目；请先开始采集并至少成功读取 1 道题');
      return;
    }
    const bounds = masteryRangeBounds();
    const date = new Date().toISOString().slice(0, 10);
    const base = `${safeFilename(state.courseTitle)}-知识点${bounds.start}-${bounds.end}-${date}`;
    const text = aiMarkdownPayload();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${base}-可直接发给AI.md`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    finalizeExportSession();
  }

  function finishRun() {
    if (!state.active && ['done', 'exported'].includes(state.phase)) return;
    state.active = false;
    state.currentTarget = null;
    state.completedAt = nowIso();
    const audit = collectionAudit();
    state.phase = 'done';
    if (!audit.actualQuestionCount) {
      addLog('所选区间已结束，但未成功读取任何题目；当前没有可导出的成果');
      return;
    }
    if (!audit.complete) {
      const detail = audit.missing.slice(0, 8).map(item => item.displayId).join('、');
      addLog(`所选区间已结束：${audit.actualQuestionCount}/${audit.expectedQuestionCount} 道题，${audit.incompleteTargetCount} 个知识点未完整，缺 ${audit.missing.length} 个题位${detail ? `（${detail}${audit.missing.length > 8 ? '…' : ''}）` : ''}；可直接导出当前成果`);
      return;
    }
    addLog(`完整采集所选 ${audit.targetCount} 个知识点，共 ${audit.actualQuestionCount}/${audit.expectedQuestionCount} 道题；请点击“导出给 AI”`);
  }

  function configureSelectedRange(checked) {
    if (!checked?.valid) return false;
    cancelEpoch += 1;
    state = {
      ...state,
      active: true,
      phase: 'mastery',
      ownerTabId: TAB_ID,
      startedAt: nowIso(),
      completedAt: '',
      exportedAt: '',
      cursor: checked.startIndex,
      rangeStart: checked.start,
      rangeEnd: checked.end,
      rangeConfigured: true,
      currentTarget: null,
      completedTargetKeys: [],
      questions: [],
      failures: []
    };
    return true;
  }

  async function startOrResume() {
    if (working) return;
    if (!ROUTE.mastery()) {
      addLog('请先回到课程的“掌握度”页面，再开始或继续采集');
      return;
    }
    const key = courseKeyFromUrl();
    const sameCourse = state.courseKey === key;
    const canResume = sameCourse && state.rangeConfigured && state.phase === 'paused' &&
      state.cursor < masteryRunEndExclusive();
    if (canResume) {
      cancelEpoch += 1;
      state.active = true;
      state.phase = 'mastery';
      state.ownerTabId = TAB_ID;
      const bounds = masteryRangeBounds();
      addLog(`继续区间 ${bounds.start}-${bounds.end}：从第 ${state.cursor + 1} 个知识点开始`);
      scheduleRouter(100);
      return;
    }

    if (sameCourse && state.rangeConfigured && state.phase === 'paused' &&
        state.cursor >= masteryRunEndExclusive()) {
      finishRun();
      return;
    }

    if (sameCourse && state.phase === 'range-ready' && state.targets.length) {
      const startValue = ui?.rangeStart?.value ?? state.rangeStart;
      const endValue = ui?.rangeEnd?.value ?? state.rangeEnd;
      const checked = validateRange(
        startValue,
        endValue,
        state.targets.length
      );
      if (!checked.valid) {
        addLog(`区间无效：${checked.message}`);
        if (ui) {
          ui.rangeStart.value = String(startValue);
          ui.rangeEnd.value = String(endValue);
        }
        return;
      }
      configureSelectedRange(checked);
      addLog(`开始采集知识点 ${checked.start}-${checked.end}，共 ${checked.count} 个；本轮从空白成果开始`);
      scheduleRouter(100);
      return;
    }

    if (sameCourse && state.phase === 'done' && orderedQuestions().length &&
        !confirm('当前采集成果尚未导出。确定放弃它并重新识别知识点吗？')) return;

    working = true;
    renderUi();
    try {
      const targets = await discoverTargets();
      if (!targets.length) {
        addLog('没有找到知识点卡片（.item-box）；请确认页面已加载完成');
        return;
      }
      const declaredTargetCount = declaredTargetCountFromPage();
      if (declaredTargetCount && targets.length !== declaredTargetCount) {
        addLog(`页面显示应有 ${declaredTargetCount} 个知识点，但只发现 ${targets.length} 个；已停止，避免整组遗漏`);
        return;
      }
      cancelEpoch += 1;
      state = {
        ...emptyState(),
        active: false,
        phase: 'range-ready',
        courseKey: key,
        courseTitle: norm(document.title) || '智慧树课程',
        masteryUrl: location.href,
        declaredTargetCount,
        targets,
        rangeStart: 1,
        rangeEnd: targets.length,
        rangeConfigured: false,
        log: []
      };
      addLog(`已识别 ${targets.length} 个知识点；请设置起始和结束序号，再点击“开始所选区间”`);
    } finally {
      working = false;
      renderUi();
    }
  }

  function stopRun() {
    if (!state.active) return;
    if (state.rangeConfigured && state.cursor >= masteryRunEndExclusive()) {
      finishRun();
      return;
    }
    cancelEpoch += 1;
    state.active = false;
    state.phase = 'paused';
    const audit = collectionAudit();
    addLog(audit.actualQuestionCount
      ? `已暂停；当前 ${audit.actualQuestionCount} 道题可直接导出，也可回到掌握度页继续所选区间`
      : '已暂停；尚未读取到题目，可回到掌握度页继续所选区间');
  }

  function clearRun() {
    if (state.active) return;
    if (!confirm('清空本脚本保存在浏览器里的采集进度和题目吗？已下载的文件不会删除。')) return;
    cancelEpoch += 1;
    GM_deleteValue(STORAGE_KEY);
    state = emptyState();
    renderUi();
  }

  function shouldShowPanel() {
    if (ROUTE.mastery()) return true;
    if ((!ROUTE.practice() && !ROUTE.result()) || !state.rangeConfigured) return false;
    if (state.active || (state.phase === 'paused' && !!state.currentTarget)) return true;
    return ['done', 'exported'].includes(state.phase) &&
      orderedQuestions().some(question => question.sourceUrl === location.href);
  }

  function renderUi() {
    if (!ui) return;
    const showPanel = shouldShowPanel();
    ui.host.style.display = showPanel ? '' : 'none';
    if (!showPanel) return;
    const bounds = masteryRangeBounds();
    const rangeProgress = selectedRangeProgress();
    const progress = `${rangeProgress.processed}/${rangeProgress.total}`;
    const ownedElsewhere = state.active && state.ownerTabId && state.ownerTabId !== TAB_ID;
    ui.status.textContent = working && !state.active ? '正在识别知识点' :
      ownedElsewhere ? `另一标签运行 ${progress}` : state.active ? `运行中 ${progress}` :
      state.phase === 'range-ready' ? `已识别 ${state.targets.length}` :
        state.phase === 'done' ? `区间结束 ${progress}` :
          state.phase === 'exported' ? `已导出 ${progress}` :
            state.phase === 'paused' ? `已暂停 ${progress}` : `待机 ${progress}`;
    const audit = collectionAudit();
    ui.count.textContent = `${audit.actualQuestionCount}${audit.expectedQuestionCount ? `/${audit.expectedQuestionCount}` : ''} 题 · ${state.failures.length} 个提示`;
    const sameCourse = !!state.courseKey && state.courseKey === courseKeyFromUrl();
    const resumable = sameCourse && state.rangeConfigured && state.phase === 'paused' &&
      state.cursor < masteryRunEndExclusive();
    const pausedAtEnd = sameCourse && state.rangeConfigured && state.phase === 'paused' &&
      state.cursor >= masteryRunEndExclusive();
    if (!ROUTE.mastery()) ui.start.textContent = '请返回掌握度页';
    else if (sameCourse && state.phase === 'range-ready') ui.start.textContent = '开始所选区间';
    else if (resumable) ui.start.textContent = '继续所选区间';
    else if (pausedAtEnd) ui.start.textContent = '完成本轮';
    else if (sameCourse && ['done', 'exported'].includes(state.phase)) ui.start.textContent = '识别新一轮';
    else ui.start.textContent = '识别知识点';
    ui.start.disabled = !!working || state.active || !ROUTE.mastery();
    ui.stop.disabled = !state.active;
    ui.exportAi.disabled = !canExportCurrentRun();
    ui.exportAi.textContent = state.phase === 'exported' ? '再次导出当前成果' :
      audit.complete ? '导出给 AI（完整）' : '导出给 AI（当前成果）';
    ui.clear.disabled = state.active || working;
    ui.rangeRow.hidden = !sameCourse || !state.targets.length;
    ui.rangeStart.min = '1';
    ui.rangeStart.max = String(Math.max(state.targets.length, 1));
    ui.rangeEnd.min = '1';
    ui.rangeEnd.max = String(Math.max(state.targets.length, 1));
    ui.rangeStart.value = String(state.rangeStart || 1);
    ui.rangeEnd.value = String(state.rangeEnd || state.targets.length || 1);
    const rangeEditable = ROUTE.mastery() && sameCourse && state.phase === 'range-ready' && !working;
    ui.rangeStart.disabled = !rangeEditable;
    ui.rangeEnd.disabled = !rangeEditable;
    ui.rangeTotal.textContent = state.rangeConfigured
      ? `已选 ${bounds.count} / 共 ${state.targets.length}`
      : `共 ${state.targets.length} 个`;
    ui.log.textContent = (state.log || []).slice(-8).join('\n') ||
      '只读取当前账号能打开的题目；不选项、不保存、不提交、不上传数据。';
  }

  function mountUi() {
    if (!document.body || document.getElementById(UI_ID)) return;
    const host = document.createElement('div');
    host.id = UI_ID;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial}.panel{position:fixed;right:18px;bottom:18px;z-index:2147483647;width:320px;
          color:#172033;background:#fff;border:1px solid #d9e0ea;border-radius:12px;box-shadow:0 8px 30px #0003;
          font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
        .head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#315efb;color:#fff}
        .head strong{font-size:14px}.body{padding:10px 12px}.meta{display:flex;justify-content:space-between;margin-bottom:8px;color:#566277}
        .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}button{border:0;border-radius:7px;padding:7px 9px;
          background:#315efb;color:#fff;font:inherit;cursor:pointer}
        button.warn{background:#fff0f0;color:#b42318}button:disabled{opacity:.45;cursor:not-allowed}
        .range{display:flex;align-items:center;gap:6px;margin:8px 0;padding:8px;border-radius:8px;background:#f2f5ff}
        .range[hidden]{display:none}.range label{font-weight:600}.range input{box-sizing:border-box;width:58px;padding:5px 6px;
          border:1px solid #c8d0df;border-radius:6px;background:#fff;color:#172033;font:inherit;text-align:center}
        .range span:last-child{margin-left:auto;color:#667085;font-size:12px}
        pre{white-space:pre-wrap;max-height:118px;overflow:auto;margin:9px 0 0;padding:8px;border-radius:7px;background:#f6f8fb;
          color:#536076;font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace}
        small{display:block;color:#7a8496;margin-top:7px}
      </style>
      <section class="panel">
        <div class="head"><strong>智慧树掌握度题目导出器</strong><span id="status">待机</span></div>
        <div class="body">
          <div class="meta"><span id="count">0 题</span><span>只读模式</span></div>
          <div id="range" class="range" hidden><label for="rangeStart">范围</label><input id="rangeStart" type="number" step="1"><span>至</span><input id="rangeEnd" type="number" step="1"><span id="rangeTotal"></span></div>
          <div class="row"><button id="start">识别知识点</button><button id="stop" class="warn">暂停</button></div>
          <div class="row"><button id="ai">导出给 AI</button></div>
          <div class="row"><button id="clear" class="warn">清空进度</button></div>
          <small>先识别知识点，再设置区间。暂停后可直接导出；导出即结束本轮采集。</small>
          <pre id="log"></pre>
        </div>
      </section>`;
    document.body.append(host);
    ui = {
      host,
      status: root.getElementById('status'),
      count: root.getElementById('count'),
      rangeRow: root.getElementById('range'),
      rangeStart: root.getElementById('rangeStart'),
      rangeEnd: root.getElementById('rangeEnd'),
      rangeTotal: root.getElementById('rangeTotal'),
      start: root.getElementById('start'),
      stop: root.getElementById('stop'),
      exportAi: root.getElementById('ai'),
      clear: root.getElementById('clear'),
      log: root.getElementById('log')
    };
    ui.start.addEventListener('click', startOrResume);
    ui.stop.addEventListener('click', stopRun);
    ui.exportAi.addEventListener('click', downloadAi);
    ui.clear.addEventListener('click', clearRun);
    renderUi();
  }

  async function routeOnce() {
    if (working) return;
    state = loadState();
    if (!state.active) {
      renderUi();
      return;
    }

    // If the site ignored target=_self and opened the exercise in a child tab,
    // that child may take ownership once. Other matching tabs remain read-only.
    if (canTakePracticeOwnership()) {
      state.ownerTabId = TAB_ID;
      saveState();
    }
    if (state.ownerTabId !== TAB_ID) {
      renderUi();
      return;
    }

    const currentParam = explicitCourseParam();
    if (ROUTE.mastery() && courseKeyFromUrl() !== state.courseKey) {
      cancelEpoch += 1;
      state.active = false;
      state.phase = 'paused';
      addLog('检测到另一门课程，已暂停以避免跨课程误操作');
      return;
    }
    if (ROUTE.practice() && currentParam && currentParam !== state.courseKey) {
      cancelEpoch += 1;
      state.active = false;
      state.phase = 'paused';
      addLog('练习页课程参数与采集任务不一致，已暂停');
      return;
    }

    const epoch = cancelEpoch;
    working = true;
    renderUi();
    try {
      if (ROUTE.mastery()) await openCurrentTarget(epoch);
      else if (ROUTE.practice()) {
        if (!canScrapeCurrentPractice()) {
          state.active = false;
          state.phase = 'paused';
          addLog('当前练习页与本轮掌握度任务不匹配，已暂停以避免误采集');
        } else {
          await scrapePractice(epoch);
        }
      }
      else if (ROUTE.result()) {
        addLog('检测到结果页；脚本不会在这里操作，正在返回掌握度页');
        location.assign(state.masteryUrl);
      } else {
        addLog('当前不在掌握度或练习页；请回到掌握度页');
        state.active = false;
        state.phase = 'paused';
        saveState();
      }
    } catch (error) {
      console.error('[智慧树题目导出] 未处理异常', error);
      recordTargetFailure(error?.message || String(error));
      state.active = false;
      state.phase = 'paused';
      addLog(`已暂停：${error?.message || error}`);
    } finally {
      working = false;
      renderUi();
    }
  }

  function scheduleRouter(delay = 500) {
    clearTimeout(routerTimer);
    routerTimer = setTimeout(routeOnce, delay);
  }

  function boot() {
    mountUi();
    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(STORAGE_KEY, (_name, _oldValue, newValue, remote) => {
        if (!remote || !newValue) return;
        const previousOwner = state.ownerTabId;
        state = { ...emptyState(), ...newValue };
        if (!state.active || (previousOwner === TAB_ID && state.ownerTabId !== TAB_ID)) cancelEpoch += 1;
        renderUi();
        if (state.active && state.ownerTabId === TAB_ID) scheduleRouter(250);
      });
    }
    if (state.active) scheduleRouter(700);
    new MutationObserver(() => {
      if (!document.getElementById(UI_ID)) {
        ui = null;
        mountUi();
      }
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        scheduleRouter(500);
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', () => scheduleRouter(400));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
