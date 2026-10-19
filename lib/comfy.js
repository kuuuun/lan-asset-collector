/*
 * 素材采集器 · ComfyUI 客户端（反推提示词）
 *
 * 只走 ComfyUI 原生节点，不要求装任何第三方节点包：
 *   LoadImage → CLIPLoader(qwen3vl_4b, type=krea2) → TextGenerate → PreviewAny
 *
 * 为什么是这套：Qwen3-VL 4B 就是 Krea 2 的文本编码器，本机已有权重
 * （models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors），8G 显存跑得动，
 * 而且是「看图片 + 听指令」的模型 —— 能按 Krea 2 的提示词结构写词，
 * 不是 Florence 那种只吐一句描述的 caption 模型。
 *
 * 整条链路：/upload/image 上传 → /prompt 排队 → /history 轮询 → 取文本输出。
 */
(function (root) {
  'use strict';
  const CC = (root.CC = root.CC || {});
  if (CC.__comfy) return;
  CC.__comfy = true;

  /**
   * 内置的「Krea 2 Turbo 反推」指令。
   *
   * 结构与 Krea 官方文档的提示词建议一致：主体先行、风格语言靠前、细节写满；
   * 输出形态取「连贯自然语言」而不是标签堆叠 —— Krea 2 吃的是描述句，不是 booru 词表。
   * 用户可在设置页整段改写（settings.comfy.instruction），这里只是默认值。
   */
  CC.KREA2_INSTRUCTION = [
    'You are an image prompt engineer. Look at the image and write ONE prompt that can be pasted directly into Krea 2 Turbo.',
    '',
    'Rules:',
    '- Output ONLY the prompt. No preface, no explanation, no title, no quotes, no markdown, no bullet points.',
    '- Write one or two flowing paragraphs of natural language. Do NOT stack comma-separated keywords or tags.',
    '- Move in this order: main subject and pose/action -> appearance, clothing and material details -> composition and camera (shot size, angle, viewpoint) -> environment and background -> lighting, colour palette and mood -> overall aesthetic and medium.',
    '- Be concrete and renderable: materials, textures, light direction, colour temperature, lens feel.',
    '- If the image contains text, reproduce the exact words and describe the typeface style and placement.',
    '- Do not invent subjects that are not in the image; when unsure, describe conservatively.',
    '- English only.'
  ].join('\n');

  /**
   * 地址规范化。
   *
   * 跨机使用时人只会填 `172.18.23.232` 或 `172.18.23.232:8188`，而 fetch 需要完整 URL；
   * 顺便把默认端口补齐、尾部斜杠去掉。**路径要保留** —— 有人用反代挂在 /comfy/ 下。
   * 只补 http 的默认端口：https 一般是 443 反代，硬塞 8188 反而连不上。
   */
  CC.normalizeComfyUrl = function (raw) {
    let s = String(raw == null ? '' : raw).trim().replace(/\s+/g, '');
    if (!s) return '';
    if (/^\/\//.test(s)) s = 'http:' + s;
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    let u;
    try {
      u = new URL(s);
    } catch (_) {
      return '';
    }
    if (!u.hostname) return '';
    if (!u.port && u.protocol === 'http:') u.port = '8188';
    return (u.origin + u.pathname).replace(/\/+$/, '');
  };

  /** 这个地址指向的是不是本机（决定连不上时该给哪套排查建议） */
  CC.isLoopbackUrl = function (raw) {
    const u = CC.normalizeComfyUrl(raw);
    if (!u) return false;
    try {
      const h = new URL(u).hostname;
      return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
    } catch (_) {
      return false;
    }
  };

  function base(cfg) {
    return CC.normalizeComfyUrl(cfg && cfg.baseUrl);
  }

  function timeoutOf(cfg, fallback) {
    const n = Number(cfg && cfg.timeout);
    return Math.max(3000, n || fallback || 60000);
  }

  /** 统一请求：超时 + 明确的网络错误文案（浏览器只给 Failed to fetch，看不出是端口还是跨域） */
  async function req(cfg, path, init) {
    const url = base(cfg);
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('ComfyUI 地址无效（填 127.0.0.1:8188 或 172.18.23.232:8188 这类即可）');
    }
    const loopback = CC.isLoopbackUrl(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutOf(cfg, 60000));
    try {
      const res = await fetch(url + path, Object.assign({ signal: ctl.signal, cache: 'no-store' }, init || {}));
      return res;
    } catch (e) {
      if (e && e.name === 'AbortError') {
        throw new Error(loopback ? 'ComfyUI 响应超时' : '这台机器响应超时：模型可能正在被别的任务占着，或网络太慢');
      }
      const m = String((e && e.message) || e);
      if (/Failed to fetch|NetworkError|network/i.test(m)) {
        // 跨机连不上，原因有好几层，直接把排查顺序给出来，别让人对着「Failed to fetch」发愣
        throw new Error(
          loopback
            ? '连不上 ComfyUI（确认已启动、端口 8188 没被别的程序占）'
            : '连不上这台机器上的 ComfyUI，按顺序查：① 对方是否用 --listen 0.0.0.0 启动（默认只听 127.0.0.1，别的机器进不来）；② 对方防火墙是否放行 8188；③ 跨网（家里 → 单位）是否已连上隧道（节点小宝 / Tailscale），地址要填隧道里的那个 IP'
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- 连通性 ---------------- */

  CC.comfyPing = async function (cfg) {
    try {
      const res = await req(cfg, '/system_stats', { method: 'GET' });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const j = await res.json();
      const dev = (j.devices && j.devices[0]) || {};
      return {
        ok: true,
        version: (j.system && j.system.comfyui_version) || '',
        device: dev.name || '',
        vram: dev.vram_total ? Math.round(dev.vram_total / 1048576) + ' MB' : ''
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  /* ---------------- 上传 ---------------- */

  /**
   * 把图片塞进 ComfyUI 的 input 目录。
   * 返回 LoadImage 能直接用的名字（有子目录时形如 "sub/xxx.png"）。
   */
  CC.comfyUpload = async function (cfg, bytes, mime, filename) {
    const fd = new FormData();
    const blob = new Blob([bytes], { type: mime || 'image/png' });
    fd.append('image', blob, filename || 'collector-' + CC.uid() + '.png');
    fd.append('overwrite', 'true');
    fd.append('type', 'input');

    const res = await req(cfg, '/upload/image', { method: 'POST', body: fd });
    if (!res.ok) throw new Error('上传图片失败（HTTP ' + res.status + '）');
    const j = await res.json();
    if (!j || !j.name) throw new Error('上传图片失败：返回里没有文件名');
    return j.subfolder ? j.subfolder + '/' + j.name : j.name;
  };

  /* ---------------- 工作流 ---------------- */

  /**
   * 反推工作流。节点编号固定，便于从 /history 里认领文本：
   *   4 = PreviewAny（文本出口）
   *
   * 注意 sampling_mode 的取值方式：TextGenerate 的 sampling_mode 是 DynamicCombo，
   * API 里要直接传选项字符串（"off" / "on"），传成 {sampling_mode:"off"} 会让
   * execute() 报「missing 1 required positional argument」。
   */
  CC.buildReverseWorkflow = function (cfg, imageName, instruction) {
    const c = cfg || {};
    return {
      1: { class_type: 'LoadImage', inputs: { image: imageName, upload: 'image' } },
      2: {
        class_type: 'CLIPLoader',
        inputs: {
          clip_name: c.clipName || 'qwen3vl_4b_fp8_scaled.safetensors',
          type: c.clipType || 'krea2',
          device: 'default'
        }
      },
      3: {
        class_type: 'TextGenerate',
        inputs: {
          clip: ['2', 0],
          prompt: String(instruction || CC.KREA2_INSTRUCTION),
          max_length: Math.max(64, Number(c.maxLength) || 420),
          sampling_mode: 'off',
          image: ['1', 0],
          use_default_template: true
        }
      },
      4: { class_type: 'PreviewAny', inputs: { source: ['3', 0] } }
    };
  };

  CC.comfyQueue = async function (cfg, workflow) {
    const res = await req(cfg, '/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: 'lan-collector-' + CC.uid() })
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j) {
      // 400 时 ComfyUI 会带回 node_errors，把它压成一句人话
      const ne = j && j.node_errors ? JSON.stringify(j.node_errors) : '';
      throw new Error('提交工作流失败（HTTP ' + res.status + '）' + (ne ? '：' + ne.slice(0, 200) : ''));
    }
    if (j.node_errors && Object.keys(j.node_errors).length) {
      throw new Error('工作流校验失败：' + JSON.stringify(j.node_errors).slice(0, 200));
    }
    if (!j.prompt_id) throw new Error('提交工作流失败：没有拿到 prompt_id');
    return j.prompt_id;
  };

  /** 从 /history 的条目里取文本；同时认领执行错误 */
  CC.comfyExtractText = function (entry) {
    if (!entry) return { ok: false, error: '没有执行结果' };

    const st = entry.status || {};
    if (st.status_str === 'error') {
      let msg = 'ComfyUI 执行失败';
      for (const m of st.messages || []) {
        if (m && m[0] === 'execution_error' && m[1]) {
          msg = m[1].exception_message || msg;
          if (m[1].node_type) msg = m[1].node_type + '：' + msg;
        }
      }
      return { ok: false, error: String(msg).trim().slice(0, 300) };
    }

    const outs = entry.outputs || {};
    for (const id of Object.keys(outs)) {
      const o = outs[id] || {};
      for (const k of ['text', 'string', 'string_list', 'value']) {
        const v = o[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'string' && v[0].trim()) {
          return { ok: true, text: CC.cleanPromptText(v[0]) };
        }
        if (typeof v === 'string' && v.trim()) return { ok: true, text: CC.cleanPromptText(v) };
      }
    }
    return { ok: false, error: '执行完成但没有拿到文本输出（工作流最后要接 PreviewAny / SaveText）' };
  };

  /** 去掉模型爱加的开场白与包裹引号 —— 那东西粘进 Krea 会变成正文 */
  CC.cleanPromptText = function (raw) {
    let t = String(raw || '').trim();
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
    t = t.replace(/^(here('| i)s?|sure[,!]?|certainly[,!]?)[^\n]*:\s*/i, '').trim();
    if (/^["“'].*["”']$/s.test(t)) t = t.slice(1, -1).trim();
    return t;
  };

  /* ---------------- 队列 ---------------- */

  /**
   * 队列状态。
   *
   * 为什么需要：反推和「出图」共用同一个 ComfyUI 队列，K 正在跑图时反推会排在后面。
   * 不把这件事显出来，界面就是一个转圈不动的大空白 —— 看起来像卡死。
   */
  CC.comfyQueueInfo = async function (cfg) {
    try {
      const res = await req(cfg, '/queue', { method: 'GET' });
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
      const j = await res.json();
      const running = (j.queue_running || []).length;
      const pending = (j.queue_pending || []).length;
      return { ok: true, running, pending };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };

  /**
   * 轮询到出结果。
   * @param onTick 每轮回调 (ms, info) —— 页面拿它显示「已等待 xx 秒 / 前面还有几个任务」
   */
  CC.comfyWait = async function (cfg, promptId, onTick) {
    const limit = timeoutOf(cfg, 300000);
    const started = Date.now();
    let delay = 600;
    let lastQueueAt = 0;
    let queueInfo = null;

    for (;;) {
      if (Date.now() - started > limit) throw new Error('等待 ComfyUI 超时（' + Math.round(limit / 1000) + ' 秒）');
      const res = await req(cfg, '/history/' + encodeURIComponent(promptId), { method: 'GET' });
      if (res.ok) {
        const j = await res.json().catch(() => null);
        const entry = j && j[promptId];
        if (entry && (entry.status && (entry.status.completed || entry.status.status_str === 'error'))) {
          const r = CC.comfyExtractText(entry);
          if (!r.ok) throw new Error(r.error);
          return r.text;
        }
      }
      // 队列状态每 2.5 秒取一次就够了：它只用来告诉用户「不是卡死，是在排队」
      if (Date.now() - lastQueueAt > 2500) {
        lastQueueAt = Date.now();
        queueInfo = await CC.comfyQueueInfo(cfg);
      }
      if (onTick) {
        try {
          onTick(Date.now() - started, queueInfo);
        } catch (_) {}
      }
      await CC.sleep(delay);
      delay = Math.min(1600, Math.round(delay * 1.3));
    }
  };

  /** 模型把指令原样吐回来（弱模型 / 小图 / 预算不够时会发生），当空结果处理 */
  function looksLikeEcho(text, instruction) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    const ins = String(instruction || '').replace(/\s+/g, ' ');
    const head = t.slice(0, 60);
    return head.length >= 20 && ins.indexOf(head) >= 0;
  }

  /** 页面/后台共用的整条链路：字节 → 上传 → 排队 → 等结果 */
  CC.comfyReverse = async function (cfg, bytes, mime, instruction, onTick) {
    const name = 'collector-' + Date.now() + '.' + CC.extFromMime(mime || 'image/png');
    const uploaded = await CC.comfyUpload(cfg, bytes, mime, name);
    if (onTick) {
      try {
        onTick(0, '已上传，等待推理');
      } catch (_) {}
    }

    const run = async (ins, maxLen) => {
      const c = Object.assign({}, cfg, { maxLength: maxLen });
      const wf = CC.buildReverseWorkflow(c, uploaded, ins);
      const id = await CC.comfyQueue(c, wf);
      const got = await CC.comfyWait(c, id, onTick);
      // 回显指令＝这一次没出词，交给下面放宽预算重试，不要把指令当提示词交给用户
      return looksLikeEcho(got, ins) ? '' : got;
    };

    const base = Math.max(64, Number(cfg && cfg.maxLength) || 420);
    const text = await run(instruction, base);
    if (text && text.trim()) return text;

    // 输出预算偏小时，贪心解码有时会立刻 EOS，拿到一个空字符串。
    // 这不是「链路坏了」，而是这一次没出词：把预算放宽、并明确要求直接开写，再试一次。
    const retry = await run(String(instruction) + '\n\nBegin the prompt immediately with the main subject. Write nothing else.', Math.max(600, base));
    if (retry && retry.trim()) return retry;
    throw new Error('模型返回了空文本：把「提示词长度上限」调大，或在设置页改写反推指令');
  };
})(self);
