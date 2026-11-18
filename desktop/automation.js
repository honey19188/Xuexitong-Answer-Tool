'use strict';

// 注入到网页里的自包含函数：读取页面快照 / 执行单个动作。
// 与扩展共用同一套元素标记（data-lt-id），只操作快照里出现过的元素。

function pageSnapshot() {
  try {
    const clean = function (value) {
      return String(value == null ? '' : value)
        .replace(/\s+/g, ' ')
        .trim();
    };
    const visible = function (el) {
      if (!el || !el.getBoundingClientRect) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    };
    const mark = function (el) {
      let id = el.getAttribute('data-lt-id');
      if (!id) {
        id = 'lt-' + Math.random().toString(36).slice(2, 10);
        el.setAttribute('data-lt-id', id);
      }
      return id;
    };
    const cssPath = function (el) {
      try {
        if (el.id) return '#' + CSS.escape(el.id);
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 4) {
          let part = node.tagName.toLowerCase();
          if (node.classList && node.classList.length) part += '.' + CSS.escape(node.classList[0]);
          const parent = node.parentElement;
          if (parent) {
            const siblings = Array.prototype.filter.call(parent.children, function (child) {
              return child.tagName === node.tagName;
            });
            if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
          }
          parts.unshift(part);
          node = parent;
          depth += 1;
        }
        return parts.join(' > ');
      } catch (error) {
        return '';
      }
    };
    const textOf = function (el, max) {
      return clean(el.innerText || el.textContent || '').slice(0, max || 200);
    };
    const labelOf = function (el) {
      const aria = el.getAttribute('aria-label');
      if (aria) return clean(aria).slice(0, 100);
      if (el.id) {
        try {
          const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (lab) return textOf(lab, 100);
        } catch (error) {
          /* 忽略非法 id */
        }
      }
      const wrap = el.closest('label');
      if (wrap) return textOf(wrap, 100);
      const prev = el.previousElementSibling;
      if (prev && /label|title|name|tip/i.test(String(prev.className || ''))) return textOf(prev, 100);
      return '';
    };

    // ---------- 可交互元素 ----------
    const elements = [];
    const seen = new Set();
    const nodes = document.querySelectorAll(
      'input, textarea, select, button, a, [role="button"], [contenteditable="true"], [onclick]',
    );
    for (let i = 0; i < nodes.length; i += 1) {
      const el = nodes[i];
      if (elements.length >= 160) break;
      if (seen.has(el) || !visible(el)) continue;
      const tag = el.tagName.toLowerCase();
      const type = String(el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && type === 'hidden') continue;
      if (tag === 'a' && !clean(el.innerText)) continue;
      seen.add(el);
      elements.push({
        id: mark(el),
        tag: tag,
        type: type || undefined,
        name: el.getAttribute('name') || undefined,
        role: el.getAttribute('role') || undefined,
        label: labelOf(el) || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        text: clean(el.innerText || el.value || '').slice(0, 120) || undefined,
        selector: cssPath(el),
        visible: true,
      });
    }

    // ---------- 题目识别 ----------
    const questions = [];
    const qSeen = new Set();
    const pushQuestion = function (q) {
      if (!q.options.length && !q.elementId) return;
      const key =
        q.stem.slice(0, 90) +
        '|' +
        q.options
          .map(function (o) {
            return o.text;
          })
          .join('|')
          .slice(0, 120);
      if (qSeen.has(key)) return;
      qSeen.add(key);
      questions.push(q);
    };

    // ---------- 题目识别（通用：按“题号 + 题型”定位每道题的块） ----------
    const QUESTION_START =
      /^\s*(\d{1,3})\s*[.、．]\s*[（(]?\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|单选|多选|判断|填空|简答|论述)/;
    const QUESTION_START_ALT =
      /^\s*[（(]\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题)\s*[)）]/;
    // 用于统计一个容器里包含多少道题（题号可能出现在任意位置）
    const QUESTION_ANY =
      /(?:^|\s)(\d{1,3})\s*[.、．]\s*[（(]?\s*(单选题|多选题|判断题|填空题|简答题|论述题|名词解释|计算题|单选|多选|判断|填空|简答|论述)/g;
    const QUESTION_NUM_ONLY = /^\s*(\d{1,3})\s*[.、．]?\s+\S/;
    const isQuestionText = function (text) {
      const value = String(text || '');
      return QUESTION_START.test(value) || QUESTION_START_ALT.test(value) || QUESTION_NUM_ONLY.test(value);
    };
    const typeLabelOf = function (text) {
      const value = String(text || '');
      const match = value.match(QUESTION_START) || value.match(QUESTION_START_ALT);
      return match ? match[2] : '';
    };
    const QUESTION_ANY_SIMPLE = /(?:^|\s)\d{1,3}\s*[.、．]?\s+(?=\S)/g;
    // 选项里的裸数字（如 "A 80 B 443 C 8080"）会被上面的简单题号规则误判成新题，
    // 先剔除「选项字母 + 数字」这种片段，再统计题号，避免选项被当成多道题。
    const stripOptionNumbers = function (text) {
      return String(text || '').replace(/[A-Fa-f]\s+\d{1,3}(?=\s|$)/g, ' ');
    };
    const countStarts = function (text) {
      const value = String(text || '');
      const typed = value.match(QUESTION_ANY) || [];
      const simple = stripOptionNumbers(value).match(QUESTION_ANY_SIMPLE) || [];
      return Math.max(typed.length, simple.length);
    };
    const countAllInputs = function (node) {
      return node && node.querySelectorAll
        ? node.querySelectorAll('input[type="radio"], input[type="checkbox"]').length
        : 0;
    };
    const nodesOf = function (scope) {
      return Array.isArray(scope) ? scope : [scope];
    };
    const scopeQuery = function (scope, selector) {
      const out = [];
      nodesOf(scope).forEach(function (node) {
        if (!node) return;
        if (node.matches && node.matches(selector)) out.push(node);
        if (node.querySelectorAll) {
          const found = node.querySelectorAll(selector);
          for (let i = 0; i < found.length; i += 1) out.push(found[i]);
        }
      });
      return out;
    };
    const scopeText = function (scope) {
      return clean(
        nodesOf(scope)
          .map(function (node) {
            return (node && (node.innerText || node.textContent)) || '';
          })
          .join(' '),
      );
    };

    const iconText = function (row) {
      const html = String((row && row.innerHTML) || '').toLowerCase();
      if (!html) return '';
      const truthy = /(dui|correct|right|true|check|tick|gou)/.test(html);
      const falsy = /(cuo|wrong|false|cross|cha)/.test(html);
      if (truthy && !falsy) return '对';
      if (falsy && !truthy) return '错';
      return '';
    };
    const readOptionText = function (row, input) {
      let text = clean((row && row.innerText) || '');
      // 学习通选项：label 里只有字母 A/B/C/D，真正的选项内容在同一个 li 的 a 标签里
      if (/^[A-Fa-f]$/.test(text) && row && row.closest) {
        const li = row.closest('li');
        if (li) text = clean(li.innerText || '');
      }
      if (!text && input) {
        text = clean(input.getAttribute('aria-label') || input.getAttribute('title') || '');
      }
      if (!text) text = iconText(row);
      if (!text && input) {
        const value = clean(input.value || '');
        if (value && !/^(on|off|a|b|c|d|e|f)$/i.test(value)) text = value;
      }
      return text;
    };

    // 找到所有以题号开头的块，只保留最内层，避免把整张试卷当成一道题
    const titled = [];
    const sections = [];
    const SECTION_TYPE = /(单选题|多选题|判断题|填空题|简答题|论述题|名词解释)/;
    const pool = document.querySelectorAll('div, li, section, article, fieldset, table');
    for (let i = 0; i < pool.length; i += 1) {
      const el = pool[i];
      if (!visible(el)) continue;
      const text = clean(el.innerText || '');
      if (!text) continue;
      // 记录“一、判断题（共10题,50.0分）”这类分区标题，用于推断题型
      if (text.length <= 120 && /(共\s*\d+\s*题|\d+\s*分)/.test(text)) {
        const match = text.match(SECTION_TYPE);
        if (match) sections.push({ el: el, label: match[1] });
      }
      if (titled.length >= 500) continue;
      if (text.length < 6 || text.length > 3500) continue;
      if (!isQuestionText(text)) continue;
      titled.push(el);
    }
    const stemBlocks = titled.filter(function (el) {
      return !titled.some(function (other) {
        return other !== el && el.contains(other);
      });
    });

    let sectionIndex = 0;
    let currentSection = '';
    stemBlocks.forEach(function (stemEl) {
      while (sectionIndex < sections.length) {
        const section = sections[sectionIndex];
        const position = section.el.compareDocumentPosition(stemEl);
        if ((position & Node.DOCUMENT_POSITION_FOLLOWING) || section.el.contains(stemEl)) {
          currentSection = section.label;
          sectionIndex += 1;
        } else {
          break;
        }
      }
      const ownText = clean(stemEl.innerText || '');
      const label = typeLabelOf(ownText) || currentSection;

      // 选项范围：题干块自身 → 向上找包含两个以上选项的容器 → 向后合并兄弟节点
      let scope = stemEl;
      if (countAllInputs(stemEl) < 2) {
        let parent = stemEl.parentElement;
        let depth = 0;
        while (parent && depth < 3) {
          if (countAllInputs(parent) >= 2) {
            if (countStarts(clean(parent.innerText || '')) <= 1) scope = parent;
            break;
          }
          parent = parent.parentElement;
          depth += 1;
        }
      }
      if (scope === stemEl && countAllInputs(stemEl) < 2) {
        const extra = [];
        let sibling = stemEl.nextElementSibling;
        let guard = 0;
        let total = countAllInputs(stemEl);
        while (sibling && guard < 8) {
          if (countStarts(clean(sibling.innerText || '')) > 0) break;
          extra.push(sibling);
          total += countAllInputs(sibling);
          guard += 1;
          if (total >= 2) break;
          sibling = sibling.nextElementSibling;
        }
        if (extra.length) scope = [stemEl].concat(extra);
      }

      // 兜底：表格/老版页面下选项可能不在相邻节点里，用常见的题目容器再取一次
      if (countAllInputs(scope) < 2) {
        const box = stemEl.closest(
          '.TiMu, .questionLi, .questionWrap, .exam-question, [data-questionid]',
        );
        if (box && box !== stemEl && countAllInputs(box) >= 2) scope = box;
      }

      const inputs = scopeQuery(scope, 'input[type="radio"], input[type="checkbox"]').filter(function (input) {
        const row = input.closest('label') || input.parentElement || input;
        return visible(input) || visible(row);
      });

      const options = [];
      const usedKeys = new Set();
      if (inputs.length >= 2) {
        inputs.slice(0, 12).forEach(function (input, index) {
          const row = input.closest('label') || input.parentElement || input;
          const text = readOptionText(row, input);
          const keyMatch =
            text.match(/^([A-Fa-f])\s*[.、:：．)）]/) ||
            text.match(/^([A-Fa-f])\s/) ||
            text.match(/^([A-Fa-f])$/);
          let key = keyMatch ? keyMatch[1].toUpperCase() : String.fromCharCode(65 + options.length);
          if (usedKeys.has(key)) key = String.fromCharCode(65 + options.length);
          usedKeys.add(key);
          options.push({
            key: key,
            text: text.slice(0, 300),
            elementId: mark(row),
            selected:
              Boolean(input.checked) ||
              /check_answer|answerBgActive|checked|selected|active/i.test(String(row.className || '')),
          });
        });
      } else {
        const cands = scopeQuery(
          scope,
          '.answerBg, .answer_p, .answerCon, .optionList li, ul.mark_list li, .option, .answer-item, .option-item',
        );
        cands.forEach(function (cand, index) {
          if (options.length >= 12) return;
          if (!visible(cand)) return;
          if (cand.querySelector('.answerBg, .answer_p, .answerCon, label, input')) return;
          const text = clean(cand.innerText || '');
          if (!text || text.length > 180) return;
          const keyMatch = text.match(/^([A-Fa-f])\s*[.、:：．)）]/) || text.match(/^([A-Fa-f])\s/);
          let key = keyMatch ? keyMatch[1].toUpperCase() : String.fromCharCode(65 + options.length);
          if (usedKeys.has(key)) key = String.fromCharCode(65 + options.length);
          usedKeys.add(key);
          options.push({
            key: key,
            text: text.slice(0, 300),
            elementId: mark(cand),
            selected: /check_answer|answerBgActive|checked|selected|active/i.test(String(cand.className || '')),
          });
        });
      }

      // 无 input 的判断题选项（对/错、正确/错误）
      const judgeLike = /判断/.test(label) || /(正确|错误|√|×)/.test(scopeText(scope).slice(0, 400));
      if (options.length === 0 && judgeLike) {
        const leaves = scopeQuery(scope, 'li, label, div, span, a, button');
        const seenText = new Set();
        leaves.forEach(function (node) {
          if (options.length >= 6) return;
          if (!visible(node)) return;
          const text = clean(node.innerText || '');
          if (!text || text.length > 24) return;
          if (!/^(?:[A-Fa-f][.、:：．)）]?\s*)?(对|错|正确|错误|√|×|是|否)$/.test(text)) return;
          if (node.querySelector('li, label, div, span, a, button')) return;
          if (seenText.has(text)) return;
          seenText.add(text);
          const keyMatch = text.match(/^([A-Fa-f])/);
          options.push({
            key: keyMatch ? keyMatch[1].toUpperCase() : String.fromCharCode(65 + options.length),
            text: text,
            elementId: mark(node),
            selected: /check_answer|answerBgActive|checked|selected|active/i.test(String(node.className || '')),
          });
        });
      }

      // 填空/简答题：收集所有填空输入框 + contenteditable
      // 多空题按空拆成多题；UEditor 富文本编辑器单独处理（只给简答题）
      const fillEls = [];
      let ueTextarea = null; // 简答题专用
      if (options.length === 0) {
        // 1) 普通可见 input / textarea（填空题用）
        const fills = scopeQuery(scope, 'input[type="text"], input:not([type])');
        for (let i = 0; i < fills.length && fillEls.length < 10; i += 1) {
          const el = fills[i];
          if (visible(el)) fillEls.push(el);
        }
        // 1.5) 可见的 textarea（排除 UEditor 隐藏 textarea）
        const tas = scopeQuery(scope, 'textarea');
        for (let i = 0; i < tas.length && fillEls.length < 10; i += 1) {
          const el = tas[i];
          const tname = (el.getAttribute && el.getAttribute('name')) || '';
          // UEditor 隐藏 textarea → 不进 fillEls，单独记录给简答题
          if (/^answer\d+$/.test(tname) && el.style.display === 'none') {
            if (!ueTextarea) ueTextarea = el;
            continue;
          }
          if (visible(el)) fillEls.push(el);
        }
        // 2) contenteditable 富文本输入
        const editables = scopeQuery(scope, '[contenteditable="true"]');
        for (let i = 0; i < editables.length && fillEls.length < 10; i += 1) {
          if (visible(editables[i]) && editables[i].innerText === '' && editables[i].offsetHeight > 20) {
            fillEls.push(editables[i]);
          }
        }
        // 2.5) 学习通填空题：每个空都是一个 UEditor，隐藏 textarea = answerEditor{题ID}{空号}
        const ueBlanks = scopeQuery(
          scope,
          'textarea[name^="answerEditor"], textarea[id^="answerEditor"]',
        );
        for (let i = 0; i < ueBlanks.length && fillEls.length < 10; i += 1) {
          if (!fillEls.includes(ueBlanks[i])) fillEls.push(ueBlanks[i]);
        }
        // 3) 兜底：找"第N空"标签附近的 input
        if (fillEls.length === 0) {
          const allEls = scopeQuery(scope, '*');
          for (let i = 0; i < allEls.length && fillEls.length < 10; i += 1) {
            const el = allEls[i];
            if (!visible(el)) continue;
            const label = (el.innerText || '').trim();
            if (/^第\s*\d+\s*空|^\(\d+\)$/.test(label) && el.nextElementSibling) {
              const input = el.nextElementSibling.querySelector('input, textarea, [contenteditable="true"]');
              if (input && !fillEls.includes(input)) fillEls.push(input);
            }
          }
        }
        // 4) UEditor 隐藏 textarea（只给简答题用，只有 fillEls 为空时才用）
        if (fillEls.length === 0 && ueTextarea) fillEls.push(ueTextarea);
      }

      let type = 'single';
      // typename 属性优先级最高（学习通官方 HTML 里直接标了 typename="简答题"）
      const typenameAttr =
        (scope.getAttribute && scope.getAttribute('typename')) ||
        (stemEl && stemEl.getAttribute && stemEl.getAttribute('typename')) ||
        '';
      if (/单选/.test(typenameAttr)) type = 'single';
      else if (/多选/.test(typenameAttr)) type = 'multiple';
      else if (/判断/.test(typenameAttr)) type = 'judge';
      else if (/填空/.test(typenameAttr)) type = 'fill';
      else if (/简答|论述|名词解释|计算|主观/.test(typenameAttr)) type = 'short';
      else if (inputs.length >= 2 && inputs[0].type === 'checkbox') type = 'multiple';
      else if (/多选|多项|至少.*项/.test(label)) type = 'multiple';
      else if (/判断/.test(label)) type = 'judge';
      else if (/简答|论述|名词解释|计算/.test(label)) type = 'short';
      else if (/填空/.test(label)) type = 'fill';
      if (options.length === 2 && /^(对|正确|√|是|错|错误|×|否)/.test(clean(options[0].text))) type = 'judge';
      // 判断题统一预设：A = 对/正确/√，B = 错/错误/×（不依赖选项在页面上的先后顺序）
      if (type === 'judge' && options.length === 2) {
        if (!clean(options[0].text) && !clean(options[1].text)) {
          // 学习通等页面选项只有图标、没有文字时的兜底（默认第一个为对、第二个为错）
          options[0].text = '对（√）';
          options[1].text = '错（×）';
        }
        options.forEach(function (opt) {
          const plain = clean(opt.text).replace(/^[A-Fa-f]\s*[.、:：．)）]?\s*/, '');
          if (/^(对|正确|√|是|true|yes|t)$/i.test(plain)) opt.key = 'A';
          else if (/^(错|错误|×|否|false|no|f)$/i.test(plain)) opt.key = 'B';
        });
      }
      if (options.length === 0 && !fillEls.length) return;

      let stem = scopeText(scope).slice(0, 1200);
      options.forEach(function (opt) {
        const text = clean(opt.text);
        if (text) stem = stem.split(text).join(' ');
      });
      // 清掉页面辅助文案（第N空、填写答案、已输入N个字）和标点前的多余空格
      stem = clean(
        stem
          .replace(/[（(]?第\s*[一二三四五六七八九十百\d]{1,3}\s*空\s*[)）]?\s*[:：]?/g, ' ')
          .replace(/已输入\s*\d+\s*个字/g, ' ')
          .replace(/填写答案/g, ' '),
      ).replace(/\s+([，。；：？！、])/g, '$1').trim();
      if (!stem) stem = ownText.slice(0, 500);

      // 题号：从 stem 开头提取 "1." / "2、" / "3．" / "4)" / "(5)" / "6 题号后只有空格" 等
      let questionIndex = 0;
      let idxMatch = stem.match(/^\s*\(?\s*(\d{1,3})\s*[.、:：．)）]\s*/);
      if (!idxMatch) idxMatch = stem.match(/^\s*(\d{1,3})\s+\S/);
      if (idxMatch) questionIndex = parseInt(idxMatch[1], 10);

      if (options.length === 0) {
        const baseType = /简答|论述|名词解释/.test(label) ? 'short' : 'fill';
        // 填空题按"整题"输出一道题：把这一题的多个空合并，答案由 AI 用 || 分隔，
        // 避免同一题干重复请求多次、也避免多空之间的答案顺序错位。
        const blankIds = fillEls.map(function (input) {
          return mark(input);
        });
        pushQuestion({
          id: 'q-' + Math.random().toString(36).slice(2, 8),
          stem: fillEls.length > 1 ? `${stem}（共 ${fillEls.length} 空）` : stem,
          type: baseType,
          options: [],
          elementId: blankIds[0],
          blankElementIds: blankIds,
          questionIndex: questionIndex,
        });
        return;
      }

      pushQuestion({
        id: 'q-' + Math.random().toString(36).slice(2, 8),
        stem: stem,
        type: type,
        options: options,
        questionIndex: questionIndex,
      });
    });

    if (questions.length === 0) {
    const containerSelectors = [
      '.questionLi',
      '.TiMu',
      '.questionWrap',
      '.question-item',
      '.exam-question',
      '[data-questionid]',
      '.singleQuesId',
      '.subject_describe',
      '.question-title',
    ];
    let containers = [];
    containerSelectors.forEach(function (sel) {
      const list = document.querySelectorAll(sel);
      for (let i = 0; i < list.length; i += 1) {
        if (visible(list[i])) containers.push(list[i]);
      }
    });
    containers = containers.filter(function (el) {
      return !containers.some(function (other) {
        return other !== el && other.contains(el);
      });
    });

    containers.forEach(function (container) {
      const stemEl = container.querySelector(
        '.Zy_TItle, .subject_describe, [class*="stem"], [class*="question-title"], [class*="title"], h3, h4',
      );

      const optionEls = [];
      const optSeen = new Set();
      const candidates = container.querySelectorAll(
        '.answerBg, .answer_p, .answerCon, .optionList li, ul.mark_list li, .option, .answer-item, label, li',
      );
      for (let i = 0; i < candidates.length; i += 1) {
        const cand = candidates[i];
        if (stemEl && stemEl !== container && stemEl.contains(cand)) continue;
        if (!visible(cand)) continue;
        const text = clean(cand.innerText);
        if (!text || text.length > 180) continue;
        if (
          cand.querySelectorAll('li, label').length > 0 &&
          !cand.matches('.answerBg, .answer_p, .answerCon, label')
        ) {
          continue;
        }
        if (optSeen.has(text)) continue;
        optSeen.add(text);
        optionEls.push(cand);
        if (optionEls.length >= 12) break;
      }

      const optionTexts = optionEls.map(function (cand) {
        return clean(cand.innerText).slice(0, 300);
      });

      let stem = clean(
        stemEl && stemEl !== container ? stemEl.innerText : container.innerText,
      ).slice(0, 1200);
      if (!stemEl || stemEl === container) {
        optionTexts.forEach(function (text) {
          if (text) stem = stem.split(text).join(' ').replace(/\s+/g, ' ').trim();
        });
      }

      const inputs = container.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      let type =
        inputs.length && inputs[0].type === 'checkbox'
          ? 'multiple'
          : /判断/.test(stem)
            ? 'judge'
            : 'single';
      if (/多选|多项|至少.*项/.test(stem)) type = 'multiple';

      const options = [];
      const usedKeys = new Set();
      optionEls.forEach(function (cand, index) {
        const text = optionTexts[index];
        const keyMatch =
          text.match(/^([A-Fa-f])\s*[.、:：．)）]/) || text.match(/^([A-Fa-f])$/);
        let key = keyMatch ? keyMatch[1].toUpperCase() : String.fromCharCode(65 + options.length);
        if (usedKeys.has(key)) key = String.fromCharCode(65 + options.length);
        usedKeys.add(key);

        let clickEl = cand;
        if (cand.matches('li')) {
          clickEl = cand.querySelector('label') || cand.querySelector('.answerBg') || cand;
        } else if (!cand.matches('label')) {
          clickEl = cand.querySelector('label') || cand;
        }
        const input = cand.querySelector('input') || (cand.matches('input') ? cand : null);
        const className = String(clickEl.className || '');
        options.push({
          key: key,
          text: text,
          elementId: mark(clickEl),
          selected:
            Boolean(input && input.checked) ||
            /check_answer|answerBgActive|checked|selected|active/i.test(className),
        });
      });

      let fillEl = null;
      if (options.length === 0) {
        const fillCandidates = container.querySelectorAll(
          'input[type="text"], input:not([type]), textarea',
        );
        for (let i = 0; i < fillCandidates.length; i += 1) {
          if (visible(fillCandidates[i])) {
            fillEl = fillCandidates[i];
            break;
          }
        }
        if (fillEl) type = 'fill';
      }

      pushQuestion({
        id: 'q-' + Math.random().toString(36).slice(2, 8),
        stem: stem,
        type: type,
        options: options,
        elementId: fillEl ? mark(fillEl) : undefined,
      });
    });

    // ---------- 兜底：按单选框/复选框分组 ----------
    if (questions.length === 0) {
      const groups = new Map();
      const radios = document.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      for (let i = 0; i < radios.length; i += 1) {
        const input = radios[i];
        if (!visible(input)) continue;
        const groupEl =
          input.closest('ul, ol, table, form, fieldset') || input.closest('div') || input.parentElement;
        const key = input.name || groupEl || input;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(input);
      }
      groups.forEach(function (inputs) {
        if (inputs.length < 2) return;
        const groupEl =
          inputs[0].closest('ul, ol, table, form, fieldset') ||
          inputs[0].closest('div') ||
          inputs[0].parentElement;
        let stem = clean(groupEl ? groupEl.innerText : '').slice(0, 500);
        const options = [];
        inputs.forEach(function (input, index) {
          const label = input.closest('label') || input.parentElement;
          const text = clean(label ? label.innerText : '').slice(0, 300) || `选项 ${index + 1}`;
          stem = stem.split(text).join(' ').replace(/\s+/g, ' ').trim();
          options.push({
            key: String.fromCharCode(65 + options.length),
            text: text,
            elementId: mark(label || input),
            selected: input.checked,
          });
        });
        pushQuestion({
          id: 'q-' + Math.random().toString(36).slice(2, 8),
          stem: stem || '（未识别题干）',
          type: inputs[0].type === 'checkbox' ? 'multiple' : 'single',
          options: options,
        });
      });
    }
    }

    let bodyText = '';
    try {
      bodyText = clean(document.body ? document.body.innerText : '').slice(0, 4000);
    } catch (error) {
      bodyText = '';
    }

    return {
      url: location.href,
      title: document.title,
      elements: elements,
      questions: questions,
      text: bodyText,
      frameTop: window === window.top,
    };
  } catch (error) {
    return { error: String(error && error.message ? error.message : error), url: location.href };
  }
}

async function performAction(step) {
  const sleep = function (ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  };
  const flash = function (el) {
    try {
      el.style.outline = '3px solid #4f8cff';
      el.style.outlineOffset = '2px';
      setTimeout(function () {
        el.style.outline = '';
        el.style.outlineOffset = '';
      }, 900);
    } catch (error) {
      /* 忽略 */
    }
  };

  // 兜底：data-lt-id 失效（翻页后 DOM 被替换），按 hint 在当前页重新找
  function resolveElement(target, hint, stepAction) {
    const selector = target
      ? '[data-lt-id="' + String(target).replace(/"/g, '\\"') + '"]'
      : '';
    let el = selector ? document.querySelector(selector) : null;
    if (el) return el;

    const stem = (hint && hint.stem) || '';
    const optionText = (hint && hint.optionText) || '';
    const clean = function (v) {
      return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
    };

    // ---- fill 动作的兜底：按 stem 找对应的 textarea/input ----
    if (stepAction === 'fill') {
      let scope = document;
      if (stem.length > 5) {
        const blocks = document.querySelectorAll('div, li, section, article, fieldset');
        let best = null;
        for (let i = 0; i < blocks.length; i += 1) {
          const t = clean(blocks[i].innerText || '');
          if (t.includes(stem.slice(0, 40)) && (!best || t.length < best.innerText.length)) {
            best = blocks[i];
          }
        }
        if (best) scope = best;
      }
      // 找所有 textarea / input
      const fills = scope.querySelectorAll('textarea, input[type="text"], input:not([type])');
      if (!fills.length) return null;
      // 多空题：stem 里带"第N空"，按顺序选第 N 个
      const m = stem.match(/第\s*(\d+)\s*空/);
      if (m) {
        const idx = Math.max(1, parseInt(m[1], 10)) - 1;
        if (fills[idx]) return fills[idx];
        return fills[fills.length - 1];
      }
      // 单选填空：取最后一个（通常在题干下方）
      return fills[fills.length - 1];
    }

    // ---- 选择动作（click/check）的兜底 ----
    if (optionText) {
      // 先缩小范围：带 stem 的块
      let scope = document;
      if (stem.length > 10) {
        const blocks = document.querySelectorAll('div, li, section, article, fieldset');
        let best = null;
        for (let i = 0; i < blocks.length; i += 1) {
          const t = clean(blocks[i].innerText || '');
          if (t.includes(stem.slice(0, 40)) && (!best || t.length < best.innerText.length)) {
            best = blocks[i];
          }
        }
        if (best) scope = best;
      }
      // 找选项元素：label / li / .option / .answerBg 等含 optionText 的
      const candidates = scope.querySelectorAll(
        'label, li, .option, .answerBg, .answer-item, .option-item, [class*="option"], [class*="answer"]',
      );
      const plain = optionText.replace(/^[A-Fa-f]\s*[.、:：．)）]\s*/, '').trim();
      for (let i = 0; i < candidates.length; i += 1) {
        const t = clean(candidates[i].innerText || '');
        if (!t) continue;
        if (t.includes(plain) || t.includes(optionText.trim())) {
          // 优先选最内层（不是容器）
          if (!candidates[i].querySelector('label, li, .option, .answerBg')) {
            return candidates[i];
          }
        }
      }
      // 兜底：找 radio/checkbox + label 的组合
      const inputs = scope.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      for (let i = 0; i < inputs.length; i += 1) {
        const lbl = inputs[i].closest('label') || inputs[i].parentElement;
        const t = clean(lbl ? lbl.innerText : '');
        if (t.includes(plain) || t.includes(optionText.trim())) {
          return lbl || inputs[i];
        }
      }
    }
    return null;
  }

  try {
    if (step.action === 'scroll') {
      const value = String(step.value || 'down');
      const amount = Number(step.amount) || Math.round(window.innerHeight * 0.8);
      if (value === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
      else if (value === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      else if (value === 'up') window.scrollBy({ top: -amount, behavior: 'smooth' });
      else window.scrollBy({ top: amount, behavior: 'smooth' });
      await sleep(350);
      return { matched: true, ok: true, detail: '已滚动：' + value };
    }

    if (step.action === 'wait') {
      const ms = Math.min(Math.max(Number(step.amount) || 500, 100), 10000);
      await sleep(ms);
      return { matched: true, ok: true, detail: '等待 ' + ms + ' 毫秒' };
    }

    if (!step.target && !step.hint) return { matched: false, ok: false, detail: '缺少目标元素' };
    const el = resolveElement(step.target, step.hint, step.action);
    if (!el) {
      const hintText = step.hint ? '（题干/选项重定位也未命中）' : '（元素已失效，且无 hint 可兜底）';
      return { matched: false, ok: false, detail: '未找到元素 ' + step.target + hintText };
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    flash(el);
    await sleep(140);

    if (step.action === 'click') {
      const target = el.matches('label, button, a, input, select, textarea')
        ? el
        : el.querySelector('label, button, a, input') || el;
      try {
        target.focus({ preventScroll: true });
      } catch (error) {
        /* 某些元素不可聚焦 */
      }
      const fire = function (type) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      };
      fire('mouseover');
      fire('mousedown');
      fire('mouseup');
      target.click();
      await sleep(220);
      const input = el.querySelector('input') || (el.matches('input') ? el : null);
      const checked = input ? input.checked : undefined;
      return {
        matched: true,
        ok: true,
        checked: checked,
        detail: checked === undefined ? '已点击' : '已点击（' + (checked ? '已选中' : '未选中') + '）',
      };
    }

    if (step.action === 'fill') {
      const value = String(step.value == null ? '' : step.value);

      // ---- UEditor 富文本编辑器 ----
      // 关键原则：只用 resolveElement 已经定位好的 el，绝不额外扫页面抢目标
      // 只有 el 本身就是 UEditor 隐藏 textarea（name/id 匹配 answer\d+）才走 setContent
      if (el && el.tagName === 'TEXTAREA') {
        const name = (el.getAttribute && el.getAttribute('name')) || el.name || '';
        const id = el.id || '';
        // 学习通简答题 = answer{题ID}；填空题每一空 = answerEditor{题ID}{空号}
        const uePattern = /^answer(Editor)?\d+$/;
        const ueId = uePattern.test(name) ? name : (uePattern.test(id) ? id : '');
        if (ueId && window.UE && typeof window.UE.getEditor === 'function') {
          try {
            const inst = window.UE.getEditor(ueId);
            if (inst && typeof inst.setContent === 'function') {
              inst.setContent(value);
              // 同步回隐藏 textarea + 触发 change
              try {
                const proto = HTMLTextAreaElement.prototype;
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(el, value);
                else el.value = value;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              } catch {}
              await sleep(180);
              return { matched: true, ok: true, detail: '已填 UEditor：' + value.slice(0, 80) };
            }
          } catch (ueErr) { /* UE 未就绪，降级到普通 textarea */ }
        }
        // UEditor iframe 降级（el 是隐藏 textarea 时，尝试从它的 holder 里找 iframe）
        const holder = el.closest('.eidtDiv') || el.parentElement;
        const iframe = holder ? holder.querySelector('iframe[id*="ueditor_"], iframe[id*="edui"]') : null;
        if (iframe && iframe.contentDocument) {
          try {
            const body = iframe.contentDocument.body;
            if (body) {
              body.innerHTML = '<p>' + value.replace(/\n/g, '</p><p>') + '</p>';
              await sleep(180);
              return { matched: true, ok: true, detail: '已填 UEditor iframe：' + value.slice(0, 80) };
            }
          } catch (iframeErr) { /* 跨域 iframe */ }
        }
      }

      // ---- contenteditable div ----
      if (el && el.getAttribute && el.getAttribute('contenteditable') === 'true') {
        el.focus({ preventScroll: true });
        el.innerText = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(120);
        return { matched: true, ok: true, detail: '已填写 contenteditable：' + value.slice(0, 80) };
      }

      // ---- 普通 textarea / input ----
      const proto =
        el && el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      el.focus({ preventScroll: true });
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      return { matched: true, ok: true, detail: '已填写：' + value.slice(0, 80) };
    }

    if (step.action === 'select') {
      const value = String(step.value == null ? '' : step.value);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      return { matched: true, ok: true, detail: '已选择：' + value };
    }

    if (step.action === 'check') {
      const desired = String(step.value) !== 'false';
      const input = el.matches('input[type="checkbox"], input[type="radio"]')
        ? el
        : el.querySelector('input[type="checkbox"], input[type="radio"]');
      const box = input || el;
      try {
        box.focus({ preventScroll: true });
      } catch (error) {
        /* 忽略不可聚焦 */
      }
      if (box.checked !== desired) box.click();
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(120);
      return { matched: true, ok: true, detail: '已' + (desired ? '勾选' : '取消勾选') };
    }

    if (step.action === 'extract') {
      return {
        matched: true,
        ok: true,
        detail: '已读取',
        text: (el.innerText || el.textContent || '').trim().slice(0, 2000),
      };
    }

    return { matched: true, ok: false, detail: '不支持的动作：' + step.action };
  } catch (error) {
    return { matched: true, ok: false, detail: String(error && error.message ? error.message : error) };
  }
}

// ---- 预翻页：自动点“下一题”把所有题 DOM 都渲染出来再抓快照 ----
// 参数：{ onProgress: function({step, collected, stem}) } 进度回调（可被 main.js 转发到前端）
// 返回：{ questions: [{ stem, options, type }], steps, url, title, pageStems: [string] }
// 每翻一页跑一遍完整 pageSnapshot，把题干/选项完整结构拿到（含 options/elementId）
// 翻完后自动回到第一题。
function preCollectAll(options) {
  const opts = options || {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
  };

  const NEXT_TEXTS = ['下一题', '下一页', '继续', '下一题>', '下一题>>', 'next', 'Next', '下一篇'];
  const PREV_TEXTS = ['上一题', '上一页', '上一步', 'prev', 'Prev', '上一篇'];
  // 学习通/常见考试页按钮的 class 特征
  const NEXT_CLASSES = ['nextPage', 'nextBtn', 'next-btn', 'btn-next', 'el-button--next', 'answerNext', 'TiMu_next', 'question-next', 'pager-next'];
  const PREV_CLASSES = ['prevPage', 'prevBtn', 'prev-btn', 'btn-prev', 'el-button--prev', 'answerPrev', 'TiMu_prev', 'question-prev', 'pager-prev'];

  // 取当前题的"签名"文字：题干 + 选项前 100 字，用于判断翻页是否生效
  function currentQSignature() {
    // 先试 pageSnapshot 拿的第一题
    if (typeof pageSnapshot === 'function') {
      const snap = pageSnapshot();
      if (snap && snap.questions && snap.questions.length) {
        const q = snap.questions[0];
        return (q.stem || '').slice(0, 80);
      }
    }
    // 兜底：扫题目类容器
    const pool = document.querySelectorAll('.TiMu, .questionLi, .subject_describe, .Zy_TItle, [class*="question"], [class*="item"]');
    for (let i = 0; i < pool.length; i += 1) {
      if (visible(pool[i])) return clean(pool[i].innerText || '').slice(0, 80);
    }
    // 兜底：body 前 300 字
    return clean(document.body ? document.body.innerText : '').slice(0, 80);
  }

  function findByText(texts, exclude) {
    const all = document.querySelectorAll('button, a, [role="button"], [onclick], span, div, li');
    for (const t of texts) {
      for (let i = 0; i < all.length; i += 1) {
        const el = all[i];
        if (!visible(el)) continue;
        const elText = clean(el.innerText || el.textContent || '');
        if (!elText.includes(t)) continue;
        if (exclude.some((p) => elText.includes(p))) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 14 || r.height > 120) continue;
        return el;
      }
    }
    return null;
  }

  function findByClass(classes) {
    for (const c of classes) {
      const hits = document.querySelectorAll('.' + c);
      for (let i = 0; i < hits.length; i += 1) {
        if (visible(hits[i])) return hits[i];
      }
    }
    return null;
  }

  // 找"下一题"按钮：class > 文字 > 右下角位置推断
  function findNextButton() {
    // 1) class 精确匹配
    let el = findByClass(NEXT_CLASSES);
    if (el) return el;
    // 2) aria-label / title 含"下一题"
    const all = document.querySelectorAll('[aria-label], [title], button, a');
    for (let i = 0; i < all.length; i += 1) {
      const a = all[i].getAttribute('aria-label') || all[i].getAttribute('title') || '';
      if (/下一题|下一页|next/i.test(a) && visible(all[i])) return all[i];
    }
    // 3) 文字匹配
    el = findByText(NEXT_TEXTS, PREV_TEXTS);
    if (el) return el;
    // 4) 位置推断：右下角的按钮（x > 80% width, y > 60% height）
    const w = window.innerWidth;
    const h = window.innerHeight;
    const all2 = document.querySelectorAll('button, a, [role="button"]');
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < all2.length; i += 1) {
      if (!visible(all2[i])) continue;
      const r = all2[i].getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < w * 0.7 || cy < h * 0.4) continue;
      const dist = (w - cx) + (h - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = all2[i];
      }
    }
    return best;
  }

  function findPrevButton() {
    let el = findByClass(PREV_CLASSES);
    if (el) return el;
    el = findByText(PREV_TEXTS, NEXT_TEXTS);
    return el;
  }

  async function press(btn) {
    if (!btn) return;
    try {
      btn.scrollIntoView({ block: 'center' });
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      btn.click();
    } catch (e) {}
  }

  // 等题干变化：最多等 3s，每 100ms 轮询一次
  async function waitForChange(prevSignature) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      await sleep(100);
      const cur = currentQSignature();
      if (cur && cur !== prevSignature) return cur;
    }
    return null;
  }

  const snap = typeof pageSnapshot === 'function' ? pageSnapshot : null;

  return (async () => {
    const collected = [];
    const pageStems = [];
    const seen = new Set();
    let steps = 0;
    const MAX_STEPS = 30;

    // 先抓当前页
    const firstSig = currentQSignature();
    if (firstSig) pageStems.push(firstSig);
    if (snap) {
      const first = snap();
      for (const q of (first && first.questions) || []) {
        const key = (q.stem || '').slice(0, 100);
        if (!seen.has(key)) {
          seen.add(key);
          collected.push(q);
        }
      }
    }
    if (opts.onProgress) {
      try { opts.onProgress({ step: 0, collected: collected.length, stem: firstSig }); } catch (e) {}
    }

    let consecutiveDupe = 0;
    let lastSig = firstSig;
    while (steps < MAX_STEPS) {
      const btn = findNextButton();
      if (!btn) break;
      await press(btn);
      steps += 1;

      // 等题干真的变了（变化=下一题加载完成）
      const changedSig = await waitForChange(lastSig);
      if (changedSig) {
        lastSig = changedSig;
        pageStems.push(changedSig);
      } else {
        // 没检测到变化也继续等 400ms 让 DOM 稳定
        await sleep(400);
      }

      if (snap) {
        const snapResult = snap();
        let added = 0;
        for (const q of (snapResult && snapResult.questions) || []) {
          const key = (q.stem || '').slice(0, 100);
          if (!seen.has(key)) {
            seen.add(key);
            collected.push(q);
            added += 1;
          }
        }
        if (added === 0) consecutiveDupe += 1;
        else consecutiveDupe = 0;
        if (opts.onProgress) {
          try {
            opts.onProgress({
              step: steps,
              collected: collected.length,
              stem: (snapResult && snapResult.questions && snapResult.questions[0])
                ? (snapResult.questions[0].stem || '').slice(0, 60)
                : changedSig || '',
            });
          } catch (e) {}
        }
        if (consecutiveDupe >= 2) break;
      } else {
        break;
      }
    }

    // 翻回第一题（优先按题号跳转进度条，如果没有就连点"上一题"）
    let backSteps = 0;
    let backBtn = findPrevButton();
    while (backBtn && backSteps < steps) {
      await press(backBtn);
      backSteps += 1;
      await sleep(250);
      backBtn = findPrevButton();
    }

    return {
      questions: collected,
      steps,
      url: location.href,
      title: document.title,
      frameTop: window === window.top,
      pageStems,
    };
  })();
}

// PRE_COLLECT_CODE：把 pageSnapshot + preCollectAll 一起注入，
// preCollectAll 内部会调用 pageSnapshot 抓每题的完整结构（含 options/elementId）
const PRE_COLLECT_CODE = `(function(){ ${pageSnapshot.toString()}; ${preCollectAll.toString()}; return preCollectAll(); })()`;

// SCROLL_ALL_CODE：滚动到页面底部触发懒加载（所有题 DOM 一次性渲染出来）
// 学习通作业/试卷详情页用这个 —— 所有题都在一个超长滚动容器里
const SCROLL_ALL_CODE = `(function(){
  return new Promise((resolve) => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 找可滚动容器（学习通通常是 body 或 .testpaper 或 .TiMu 祖先）
    const findScrollable = () => {
      const candidates = [
        document.scrollingElement,
        document.body,
        document.documentElement,
        document.querySelector('.testpaper'),
        document.querySelector('.papercontent'),
        document.querySelector('#scrollyscrollbar'),
        document.querySelector('.scrollbarDiv'),
      ];
      for (const c of candidates) {
        if (c && c.scrollHeight > c.clientHeight + 200) return c;
      }
      // 兜底：最大的那个 scrollable
      let best = document.scrollingElement;
      let bestH = 0;
      document.querySelectorAll('*').forEach((el) => {
        const sh = el.scrollHeight, ch = el.clientHeight;
        if (sh > ch + 200 && sh > bestH) { best = el; bestH = sh; }
      });
      return best;
    };

    let scroller = findScrollable();
    if (!scroller) { resolve({ ok: false, reason: 'no-scroll-container' }); return; }

    (async () => {
      let lastH = -1;
      let stable = 0;
      let steps = 0;
      const MAX_STEPS = 80;
      while (steps < MAX_STEPS) {
        scroller.scrollTop += Math.max(300, Math.floor(scroller.clientHeight * 0.8));
        steps += 1;
        await sleep(180);
        const h = scroller.scrollHeight;
        if (h === lastH) {
          stable += 1;
          if (stable >= 4) break;
        } else {
          stable = 0;
          lastH = h;
        }
      }
      // 再滚一次到最底（确保所有懒加载触发）
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(400);
      // 回到顶部（保持用户视觉不变）
      scroller.scrollTop = 0;
      resolve({ ok: true, steps, scrollHeight: lastH || scroller.scrollHeight });
    })();
  });
})()`;

// 原本的单页快照（未预翻页），保持兼容
const SNAPSHOT_CODE = `(${pageSnapshot.toString()})()`;

function actionCode(step) {
  return `(${performAction.toString()})(${JSON.stringify(step)})`;
}

module.exports = { pageSnapshot, performAction, SNAPSHOT_CODE, SCROLL_ALL_CODE, actionCode, preCollectAll, PRE_COLLECT_CODE };
