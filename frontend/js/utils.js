/* ========================================
   数字治理平台 V7 - 工具函数
   ======================================== */

const Utils = {
  /** HTML转义 */
  esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  },

  /** 生成唯一ID */
  id(prefix = "id_") {
    return prefix + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  },

  /** ISO时间 */
  now() { return new Date().toISOString(); },

  /** 今天日期 yyyy-MM-dd */
  today() { return new Date().toISOString().split("T")[0]; },

  /** Toast提示 */
  toast(msg) {
    const el = document.getElementById("toast");
    if (!el) { alert(msg); return; }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(Utils._toastTimer);
    Utils._toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  },

  /** 全角数字转半角 */
  normalizeDigits(v) {
    return String(v ?? "").replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - 0xFF10)).trim();
  },

  /** 人员去重用：姓名 + 工号。纯数字工号比较时忽略前导 0。 */
  normalizeEmployeeNoKey(v) {
    const no = Utils.normalizeDigits(v || "").trim();
    if (/^\d+$/.test(no)) return String(Number(no));
    return no.toLowerCase();
  },

  memberIdentityKey(name, employeeNo) {
    const cleanName = String(name || "").trim().replace(/\s+/g, " ");
    const cleanNo = Utils.normalizeEmployeeNoKey(employeeNo);
    return `${cleanName}||${cleanNo}`;
  },

  personIdentityFromText(text) {
    const raw = String(text || "").trim();
    if (!raw) return { name: "", employeeNo: "" };
    const normalized = raw.replace(/（/g, "(").replace(/）/g, ")").replace(/／/g, "/");
    if (normalized.includes("/")) {
      const [name, employeeNo] = normalized.split("/");
      return { name: (name || "").trim(), employeeNo: Utils.normalizeDigits(employeeNo || "") };
    }
    const paren = normalized.match(/^(.+?)\((.+?)\)$/);
    if (paren) return { name: paren[1].trim(), employeeNo: Utils.normalizeDigits(paren[2] || "") };
    return { name: normalized, employeeNo: "" };
  },

  personText(name, employeeNo) {
    const cleanName = String(name || "").trim();
    const cleanNo = Utils.normalizeDigits(employeeNo || "");
    return cleanName && cleanNo ? `${cleanName}/${cleanNo}` : "";
  },

  personMatchesMember(personText, member) {
    const p = Utils.personIdentityFromText(personText);
    const memberName = String(member?.name || "").trim();
    const memberNo = Utils.normalizeEmployeeNoKey(member?.employeeNo || "");
    if (p.name && p.employeeNo) return Utils.memberIdentityKey(p.name, p.employeeNo) === Utils.memberIdentityKey(memberName, memberNo);
    const text = String(personText || "");
    return !!(memberName && memberNo && text.includes(memberName) && text.includes(member?.employeeNo || ""));
  },

  memberRoleValue(value, fallback = "tester") {
    const text = String(value || "").trim().toLowerCase();
    const normalized = text.replace(/\s+/g, "");
    if (["tester", "test", "qa", "测试", "测试人员", "测试员"].includes(normalized)) return "tester";
    if (["developer", "dev", "研发", "研发人员", "开发", "开发人员", "工程师"].includes(normalized)) return "developer";
    if (["other", "others", "其他", "其他人员"].includes(normalized)) return "other";
    return ["tester", "developer", "other"].includes(fallback) ? fallback : "tester";
  },

  memberRoleLabel(role) {
    const value = Utils.memberRoleValue(role);
    if (value === "developer") return "开发人员";
    if (value === "other") return "其他人员";
    return "测试人员";
  },

  /** 解析正整数 */
  parsePositiveInt(v) {
    const s = Utils.normalizeDigits(v);
    if (!/^[1-9]\d*$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  },

  /** JSON字符串安全处理 */
  jsArg(v) { return JSON.stringify(String(v ?? "")); },

  /** 完整 CSV 解析：支持引号内逗号、双引号和跨行字段。 */
  parseCsv(text) {
    const source = String(text ?? "").replace(/^﻿/, "");
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    let quoteClosed = false;
    let fieldPresent = false;
    const pushField = () => {
      row.push(field.trim());
      field = "";
      quoteClosed = false;
      fieldPresent = false;
    };
    const pushRow = () => { pushField(); rows.push(row); row = []; };
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];
      if (inQuotes) {
        if (ch === '"' && next === '"') { field += '"'; i++; continue; }
        if (ch === '"') { inQuotes = false; quoteClosed = true; continue; }
        field += ch;
        fieldPresent = true;
        continue;
      }
      if (quoteClosed) {
        if (ch === ",") { pushField(); continue; }
        if (ch === "\r" || ch === "\n") {
          if (ch === "\r" && next === "\n") i++;
          pushRow();
          continue;
        }
        if (/\s/.test(ch)) continue;
        throw new Error("CSV 引号字段结束后包含非法字符");
      }
      if (ch === '"') {
        if (field.trim()) throw new Error("CSV 未引用字段中包含非法引号");
        field = "";
        fieldPresent = true;
        inQuotes = true;
        continue;
      }
      if (ch === "," && !inQuotes) { pushField(); continue; }
      if ((ch === "\r" || ch === "\n") && !inQuotes) {
        if (ch === "\r" && next === "\n") i++;
        pushRow();
        continue;
      }
      field += ch;
      fieldPresent = true;
    }
    if (inQuotes) throw new Error("CSV 包含未闭合的引号字段");
    if (fieldPresent || row.length) pushRow();
    return rows;
  },

  /** CSV行解析（兼容旧调用）。 */
  parseCsvLine(line) {
    return Utils.parseCsv(String(line ?? ""))[0] || [];
  },

  /** 解析测试用例CSV */
  parseTestCaseCsv(text) {
    let lines;
    try { lines = Utils.parseCsv(text).filter(cols => cols.some(value => String(value || "").trim())); }
    catch (_) { return []; }
    const rows = [];
    lines.forEach((cols, idx) => {
      if (cols.length < 2) return;
      const category = (cols[0] || "").trim();
      const item = (cols[1] || "").trim();
      if (!category || !item) return;
      if (idx === 0 && /测量类别|测试大类|类别/i.test(category) && /用例|项目|名称/i.test(item)) return;
      rows.push({ category, item });
    });
    return rows;
  },

  /** 解析项目人员CSV：支持旧版单列 "姓名/工号"，以及新版 "姓名/工号,人员类型" */
  parseProjectMembersCsv(text) {
    let lines;
    try {
      lines = Utils.parseCsv(text).filter(cols => cols.some(value => String(value || "").trim()));
    } catch (e) {
      return { error: e.message || String(e), rows: [] };
    }
    if (!lines.length) return { error: "CSV文件没有可读取的数据", rows: [] };

    const rows = [];
    const seen = new Set();
    let skipped = 0;

    for (let i = 0; i < lines.length; i++) {
      const cols = lines[i];
      if (cols.every(c => !c.trim())) continue;
      const first = String(cols[0] || "").trim();
      const second = String(cols[1] || "").trim();
      if (i === 0 && Utils.normalizeImportHeader(first) === Utils.normalizeImportHeader("姓名/工号")) continue;
      if (cols.length > 2) { skipped++; continue; }
      const parsed = Utils.parsePersonField(first);
      if (!parsed.ok) { skipped++; continue; }
      const { name, employeeNo } = parsed;
      const role = Utils.memberRoleValue(second || "tester");

      const key = Utils.memberIdentityKey(name, employeeNo);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      rows.push({ name, employeeNo, role });
    }

    if (!rows.length) return { error: "CSV中没有符合条件的人员数据", rows: [], skipped };
    return { error: null, rows, skipped };
  },

  sampleImportAliases() {
    return {
      '带入时间': ['带入时间', '入库时间', '录入时间', '日期', 'date'],
      '借用时间': ['借用时间', '借出时间', '领用时间', 'borrow date', 'borrowed at'],
      '阶段': ['阶段', 'stage', '版本'],
      '方案': ['方案', '方案(制式/配置/型号/SKU/厂家)', '方案(制式/配置/型号/sku/厂家)', '制式', '平台方案', 'platform', '芯片方案', '型号', '标准'],
      '型号/方案': ['型号/方案', '型号 / 方案', 'model / platform'],
      '配置/制式': ['配置/制式', '配置 / 制式', 'config / standard'],
      'SKU/版本': ['SKU/版本', 'SKU / 版本', 'sku / version'],
      '方案编号': ['方案编号', '方案号', '编号', 'scheme no', 'scheme'],
      '初检问题': ['初检问题录入', '初检结果', '初检', '检查结果', '样机问题表', 'initial result', '初检问题录入（无问题不填写或写"/"）'],
      'IMEI': ['imei', 'imei号', 'imei1', 'IMEI号'],
      'SN': ['sn', 'sn号', 'SN号', '序列号', 'serial'],
      '主板SN': ['主板SN', '主板SN号', '主板序列号', 'board sn', 'main board sn', 'motherboard sn'],
      '重组样机': ['是否重组样机', '重组样机', '是否重组', '重组', 'reassembled', 'is reassembled'],
      '样机状态': ['样机状态', '状态', 'status'],
      '带入位置': ['带入位置', '位置', '样机位置', '入库位置', '存放位置', 'location'],
      '标签': ['标签', 'tag', 'label'],
      '挂账人': ['挂账人', '挂账人(姓名/工号)', '挂账人姓名工号', '责任人', 'owner'],
      '持有人': ['持有人', '持有人(姓名/工号)', '领用人', '领用人(姓名/工号)', '使用人', '当前使用人', 'user'],
      '备注': ['其他备注信息', '备注', '说明', 'notes']
    };
  },

  /** 解析日期字段：多种格式转为 yyyy-MM-dd */
  parseSampleDateField(v) {
    const raw = String(v ?? "").trim();
    if (!raw) return "";
    // 尝试 yyyy/MM/dd 或 yyyy-MM-dd
    let match = raw.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
    if (match) {
      const [, y, m, d] = match;
      return `${y}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
    }
    // 尝试 MM/dd/yyyy
    match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (match) {
      const [, m, d, y] = match;
      return `${y}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
    }
    return raw;
  },

  parseSampleReassembledFlag(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v === 1;
    const text = String(v ?? "").trim().toLowerCase();
    if (!text) return false;
    if (["是", "yes", "y", "true", "1", "重组", "reassembled"].includes(text)) return true;
    if (["否", "no", "n", "false", "0", "非重组", "不是"].includes(text)) return false;
    return false;
  },

  /** 解析姓名/工号字段: 格式为 "姓名/工号"
   *  返回 { name, employeeNo, raw, nameOk, noOk, ok, msg }
   *  msg 为非空时即具体的校验失败原因，全局统一使用。 */
  parsePersonField(v) {
    const raw = String(v ?? "").replace(/／/g, "/").trim();
    if (!raw) return { name: "", employeeNo: "", raw: "", nameOk: false, noOk: false, ok: false, msg: "" };
    const parts = raw.split("/");
    if (parts.length !== 2) {
      const fallback = Utils.personIdentityFromText(raw);
      return { name: fallback.name || "", employeeNo: fallback.employeeNo || "", raw, nameOk: false, noOk: false, ok: false, msg: "人员格式必须为「姓名/工号」" };
    }
    const name = String(parts[0] || "").trim();
    const employeeNo = Utils.normalizeDigits(parts[1] || "");
    // 姓名校验：只能包含中文汉字和英文字母
    if (!name) return { name: "", employeeNo, raw, nameOk: false, noOk: /^[A-Za-z0-9]+$/.test(employeeNo) && employeeNo.length > 0, ok: false, msg: "姓名不能为空" };
    if (!/^[一-龥A-Za-z ]+$/.test(name)) return { name, employeeNo, raw, nameOk: false, noOk: /^[A-Za-z0-9]+$/.test(employeeNo) && employeeNo.length > 0, ok: false, msg: "姓名只能包含汉字或字母" };
    // 工号校验：只能包含数字或数字和英文字母的组合，不能有汉字
    if (!employeeNo) return { name, employeeNo, raw, nameOk: true, noOk: false, ok: false, msg: "工号不能为空，人员必须按「姓名/工号」填写" };
    if (!/^[A-Za-z0-9]+$/.test(employeeNo)) return { name, employeeNo, raw, nameOk: true, noOk: false, ok: false, msg: "工号只能包含字母或数字" };
    return { name, employeeNo, raw, nameOk: true, noOk: true, ok: true, msg: "" };
  },

  normalizeImportHeader(v) {
    return String(v ?? "")
      .toLowerCase()
      .replace(/[＊*]/g, "")
      .replace(/[（(].*?[）)]/g, "")
      .replace(/\s+/g, "")
      .trim();
  },

  isNoSampleIssueText(v) {
    const text = String(v ?? "").trim();
    if (!text) return true;
    const compact = text.replace(/\s+/g, "").replace(/[。；;，,]/g, "");
    return [
      "/",
      "-",
      "无",
      "无问题",
      "没有问题",
      "无异常",
      "正常",
      "na",
      "n/a",
      "none",
      "null",
      "（无问题不用填写）",
      "(无问题不用填写)"
    ].includes(compact.toLowerCase());
  },

  parseSampleIssueText(v) {
    return String(v ?? "")
      .split(/\r?\n|；|;/)
      .map(x => x.trim())
      .filter(x => x && !Utils.isNoSampleIssueText(x));
  },

  parseSampleImportMatrix(matrix, sourceName = "模板") {
    const rowsMatrix = (matrix || [])
      .map(row => (row || []).map(v => String(v ?? "").trim()))
      .filter(row => row.some(Boolean));
    if (rowsMatrix.length < 2) return { error: `${sourceName}至少需要标题行和一行数据`, rows: [] };

    const header = rowsMatrix[0];
    const colMap = {};
    const aliases = Utils.sampleImportAliases();

    header.forEach((h, i) => {
      const hLower = Utils.normalizeImportHeader(h);
      for (const [key, names] of Object.entries(aliases)) {
        if (names.some(n => hLower === Utils.normalizeImportHeader(n))) {
          colMap[key] = i;
          break;
        }
      }
    });

    // 检查必填列
    const hasAtLeastOneId = colMap['IMEI'] !== undefined || colMap['SN'] !== undefined || colMap['主板SN'] !== undefined;
    if (!hasAtLeastOneId) {
      return { error: `${sourceName}必须至少包含 IMEI、SN 或主板SN列`, rows: [] };
    }

    const rows = [];
    let invalidPersonCount = 0;
    for (let i = 1; i < rowsMatrix.length; i++) {
      const cols = rowsMatrix[i];
      if (cols.every(c => !c.trim())) continue; // 跳过空行

      const get = (key) => (colMap[key] !== undefined ? (cols[colMap[key]] || "").trim() : "");
      const imei = get('IMEI');
      const sn = get('SN');
      const boardSn = get('主板SN');

      // 至少有一个标识
      if (!imei && !sn && !boardSn) continue;

      const ownerField = get('挂账人');
      const ownerParsed = Utils.parsePersonField(ownerField);
      const ownerText = ownerParsed.ok ? Utils.personText(ownerParsed.name, ownerParsed.employeeNo) : "";
      if (ownerField && !ownerParsed.ok) invalidPersonCount++;
      const borrowerField = get('持有人');
      const borrowerParsed = Utils.parsePersonField(borrowerField);
      const borrowerText = borrowerParsed.ok ? Utils.personText(borrowerParsed.name, borrowerParsed.employeeNo) : "";
      if (borrowerField && !borrowerParsed.ok) invalidPersonCount++;
      const legacyScheme = get('方案');
      const exportedConfig = get('配置/制式');
      const exportedSkuName = get('SKU/版本');

      rows.push({
        importDate: Utils.parseSampleDateField(get('带入时间')),
        borrowDate: Utils.parseSampleDateField(get('借用时间')),
        stage: get('阶段') || 'Unknown',
        standard: exportedConfig || legacyScheme || '',
        platform: get('型号/方案') || '',
        skuName: exportedSkuName || legacyScheme || exportedConfig || '',
        schemeNo: get('方案编号') || '',
        initialResult: Utils.parseSampleIssueText(get('初检问题')).join("\n"),
        imei: imei,
        sn: sn,
        boardSn: boardSn,
        isReassembled: Utils.parseSampleReassembledFlag(get('重组样机')),
        status: get('样机状态') || '闲置',
        location: get('带入位置') || '',
        tag: get('标签') || '',
        owner: ownerText,
        borrower: borrowerText,
        notes: get('备注') || ''
      });
    }

    return { error: null, rows, invalidPersonCount };
  },

  /** 解析样机导入CSV */
  parseSampleImportCsv(text) {
    try {
      const matrix = Utils.parseCsv(text).filter(row => row.some(value => String(value || "").trim()));
      return Utils.parseSampleImportMatrix(matrix, "CSV文件");
    } catch (e) {
      return { error: e.message || String(e), rows: [] };
    }
  },

  async parseSampleImportXlsx(buffer) {
    try {
      const files = await Utils.unzipXlsxFiles(buffer);
      const sharedStrings = Utils.parseXlsxSharedStrings(files["xl/sharedStrings.xml"] || "");
      const styles = Utils.parseXlsxDateStyles(files["xl/styles.xml"] || "");
      const sheetPath = Object.keys(files).find(x => /^xl\/worksheets\/sheet\d+\.xml$/i.test(x));
      if (!sheetPath) return { error: "XLSX中没有找到工作表", rows: [] };
      const matrix = Utils.parseXlsxSheet(files[sheetPath], sharedStrings, styles);
      return Utils.parseSampleImportMatrix(matrix, "XLSX模板");
    } catch (e) {
      return { error: e.message || String(e), rows: [] };
    }
  },

  async unzipXlsxFiles(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
    const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
    const MAX_TOTAL_XML_BYTES = 50 * 1024 * 1024;
    const MAX_ENTRIES = 2048;
    if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("XLSX文件过大，最大支持 25MB");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的XLSX文件");
    const total = view.getUint16(eocd + 10, true);
    if (total > MAX_ENTRIES) throw new Error(`XLSX文件条目过多，最大支持 ${MAX_ENTRIES} 项`);
    let ptr = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder("utf-8");
    const files = {};
    let totalXmlBytes = 0;

    for (let i = 0; i < total; i++) {
      if (ptr < 0 || ptr + 46 > bytes.length) throw new Error("XLSX目录结构越界");
      if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("XLSX目录结构损坏");
      const method = view.getUint16(ptr + 10, true);
      const compressedSize = view.getUint32(ptr + 20, true);
      const uncompressedSize = view.getUint32(ptr + 24, true);
      const fileNameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOffset = view.getUint32(ptr + 42, true);
      const nameBytes = bytes.slice(ptr + 46, ptr + 46 + fileNameLen);
      const fileName = decoder.decode(nameBytes);

      const nextPtr = ptr + 46 + fileNameLen + extraLen + commentLen;
      if (nextPtr > bytes.length) throw new Error("XLSX目录条目越界");
      ptr = nextPtr;
      if (!/\.(xml|rels)$/i.test(fileName)) continue;
      if (Object.prototype.hasOwnProperty.call(files, fileName)) throw new Error(`XLSX包含重复条目：${fileName}`);
      if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`XLSX条目过大：${fileName}`);
      totalXmlBytes += uncompressedSize;
      if (totalXmlBytes > MAX_TOTAL_XML_BYTES) throw new Error("XLSX解压后的XML内容过大");

      if (localOffset < 0 || localOffset + 30 > bytes.length) throw new Error("XLSX文件头越界");
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("XLSX文件头损坏");
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      if (dataStart < 0 || dataStart + compressedSize > bytes.length) throw new Error("XLSX压缩数据越界");
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      let dataBytes;
      if (method === 0) {
        dataBytes = compressed;
      } else if (method === 8) {
        dataBytes = await Utils.inflateRawBytes(compressed, uncompressedSize || MAX_ENTRY_BYTES);
      } else {
        throw new Error(`XLSX使用了不支持的压缩方式：${method}`);
      }
      if (dataBytes.length !== uncompressedSize) throw new Error(`XLSX条目解压大小不匹配：${fileName}`);
      files[fileName] = decoder.decode(dataBytes);
    }
    return files;
  },

  async inflateRawBytes(compressed, maxOutputBytes = 20 * 1024 * 1024) {
    const root = typeof globalThis !== "undefined" ? globalThis : window;
    const NativeDecompressionStream = root.DecompressionStream || root.window?.DecompressionStream;
    if (NativeDecompressionStream && root.Blob && root.Response) {
      const stream = new root.Blob([compressed]).stream().pipeThrough(new NativeDecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxOutputBytes) {
          await reader.cancel();
          throw new Error("XLSX解压内容超过安全上限");
        }
        chunks.push(value);
      }
      const output = new Uint8Array(total);
      let offset = 0;
      chunks.forEach(chunk => { output.set(chunk, offset); offset += chunk.byteLength; });
      return output;
    }
    return Utils.inflateRawBytesFallback(compressed, maxOutputBytes);
  },

  inflateRawBytesFallback(compressed, maxOutputBytes = 20 * 1024 * 1024) {
    const input = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
    let bitPos = 0;
    const output = [];
    const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const appendOutput = value => {
      if (output.length >= maxOutputBytes) throw new Error("XLSX解压内容超过安全上限");
      output.push(value);
    };

    const readBits = count => {
      let value = 0;
      for (let i = 0; i < count; i++) {
        if ((bitPos >> 3) >= input.length) throw new Error("XLSX压缩数据损坏");
        value |= ((input[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
        bitPos++;
      }
      return value;
    };
    const reverseBits = (value, length) => {
      let reversed = 0;
      for (let i = 0; i < length; i++) {
        reversed = (reversed << 1) | (value & 1);
        value >>= 1;
      }
      return reversed;
    };
    const buildHuffman = lengths => {
      const maxBits = Math.max(...lengths, 0);
      const counts = Array(maxBits + 1).fill(0);
      const nextCode = Array(maxBits + 1).fill(0);
      const tables = Array.from({ length: maxBits + 1 }, () => new Map());
      lengths.forEach(len => { if (len) counts[len]++; });
      let code = 0;
      for (let bits = 1; bits <= maxBits; bits++) {
        code = (code + counts[bits - 1]) << 1;
        nextCode[bits] = code;
      }
      lengths.forEach((len, symbol) => {
        if (!len) return;
        const canonical = nextCode[len]++;
        tables[len].set(reverseBits(canonical, len), symbol);
      });
      return { maxBits, tables };
    };
    const decodeSymbol = tree => {
      let code = 0;
      for (let len = 1; len <= tree.maxBits; len++) {
        code |= readBits(1) << (len - 1);
        const symbol = tree.tables[len].get(code);
        if (symbol !== undefined) return symbol;
      }
      throw new Error("XLSX压缩编码损坏");
    };
    const fixedTrees = () => {
      const literalLengths = Array(288).fill(0).map((_, i) => {
        if (i <= 143) return 8;
        if (i <= 255) return 9;
        if (i <= 279) return 7;
        return 8;
      });
      return { literalTree: buildHuffman(literalLengths), distanceTree: buildHuffman(Array(32).fill(5)) };
    };
    const dynamicTrees = () => {
      const hlit = readBits(5) + 257;
      const hdist = readBits(5) + 1;
      const hclen = readBits(4) + 4;
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      const codeLengths = Array(19).fill(0);
      for (let i = 0; i < hclen; i++) codeLengths[order[i]] = readBits(3);
      const codeTree = buildHuffman(codeLengths);
      const lengths = [];
      while (lengths.length < hlit + hdist) {
        const symbol = decodeSymbol(codeTree);
        if (symbol <= 15) {
          lengths.push(symbol);
        } else if (symbol === 16) {
          const repeat = readBits(2) + 3;
          const prev = lengths[lengths.length - 1] || 0;
          for (let i = 0; i < repeat; i++) lengths.push(prev);
        } else if (symbol === 17) {
          const repeat = readBits(3) + 3;
          for (let i = 0; i < repeat; i++) lengths.push(0);
        } else if (symbol === 18) {
          const repeat = readBits(7) + 11;
          for (let i = 0; i < repeat; i++) lengths.push(0);
        }
      }
      return {
        literalTree: buildHuffman(lengths.slice(0, hlit)),
        distanceTree: buildHuffman(lengths.slice(hlit, hlit + hdist))
      };
    };
    const inflateCompressedBlock = (literalTree, distanceTree) => {
      while (true) {
        const symbol = decodeSymbol(literalTree);
        if (symbol < 256) {
          appendOutput(symbol);
        } else if (symbol === 256) {
          return;
        } else if (symbol <= 285) {
          const idx = symbol - 257;
          if (idx >= lengthBase.length) throw new Error("XLSX压缩长度损坏");
          const length = lengthBase[idx] + readBits(lengthExtra[idx]);
          const distSymbol = decodeSymbol(distanceTree);
          if (distSymbol >= distBase.length) throw new Error("XLSX压缩距离损坏");
          const distance = distBase[distSymbol] + readBits(distExtra[distSymbol]);
          if (!distance || distance > output.length) throw new Error("XLSX压缩距离损坏");
          for (let i = 0; i < length; i++) appendOutput(output[output.length - distance]);
        } else {
          throw new Error("XLSX压缩长度损坏");
        }
      }
    };

    let isFinal = false;
    while (!isFinal) {
      isFinal = !!readBits(1);
      const type = readBits(2);
      if (type === 0) {
        bitPos = Math.ceil(bitPos / 8) * 8;
        const len = readBits(16);
        const nlen = readBits(16);
        if (((len ^ 0xffff) & 0xffff) !== nlen) throw new Error("XLSX未压缩块损坏");
        for (let i = 0; i < len; i++) appendOutput(readBits(8));
      } else if (type === 1) {
        const trees = fixedTrees();
        inflateCompressedBlock(trees.literalTree, trees.distanceTree);
      } else if (type === 2) {
        const trees = dynamicTrees();
        inflateCompressedBlock(trees.literalTree, trees.distanceTree);
      } else {
        throw new Error("XLSX压缩块类型不支持");
      }
    }
    return new Uint8Array(output);
  },

  parseXlsxSharedStrings(xml) {
    if (!xml) return [];
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    return Array.from(doc.getElementsByTagName("si")).map(si => si.textContent || "");
  },

  parseXlsxDateStyles(xml) {
    const dateStyleIndexes = new Set();
    if (!xml) return dateStyleIndexes;
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const customDateIds = new Set();
    Array.from(doc.getElementsByTagName("numFmt")).forEach(fmt => {
      const id = fmt.getAttribute("numFmtId");
      const code = fmt.getAttribute("formatCode") || "";
      if (/[ymdhHsS年月日]/.test(code)) customDateIds.add(id);
    });
    const builtInDateIds = new Set(["14", "15", "16", "17", "18", "19", "20", "21", "22", "45", "46", "47"]);
    const xfs = doc.getElementsByTagName("cellXfs")[0]?.getElementsByTagName("xf") || [];
    Array.from(xfs).forEach((xf, idx) => {
      const numFmtId = xf.getAttribute("numFmtId");
      if (builtInDateIds.has(numFmtId) || customDateIds.has(numFmtId)) dateStyleIndexes.add(String(idx));
    });
    return dateStyleIndexes;
  },

  parseXlsxSheet(xml, sharedStrings, dateStyleIndexes) {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    const out = [];
    Array.from(doc.getElementsByTagName("row")).forEach(row => {
      const values = [];
      Array.from(row.getElementsByTagName("c")).forEach(cell => {
        const ref = cell.getAttribute("r") || "";
        const colLetters = ref.replace(/\d+/g, "");
        let col = 0;
        for (const ch of colLetters) col = col * 26 + ch.charCodeAt(0) - 64;
        col = Math.max(0, col - 1);
        const type = cell.getAttribute("t");
        const style = cell.getAttribute("s");
        const v = cell.getElementsByTagName("v")[0]?.textContent || "";
        let value = "";
        if (type === "s") {
          value = sharedStrings[Number(v)] || "";
        } else if (type === "inlineStr") {
          value = cell.textContent || "";
        } else if (dateStyleIndexes.has(style) && v && !Number.isNaN(Number(v))) {
          value = Utils.excelSerialToDate(Number(v));
        } else {
          value = v;
        }
        values[col] = value;
      });
      out.push(values);
    });
    return out;
  },

  excelSerialToDate(serial) {
    const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
    const pad = n => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  },

  /** CSV转义 */
  csvEscape(v) { return `"${String(v ?? "").replace(/"/g, '""')}"`; },

  /** 导出时间戳 */
  exportTimestamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  },

  /** 安全文件名 */
  sanitizeFileName(name) {
    return String(name || "export").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 120);
  },

  /** 下载文本文件 */
  downloadText(content, filename, type = "text/plain;charset=utf-8") {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  },

  /** 下载CSV */
  downloadCsv(rows, filename) {
    const csv = rows.map(r => r.map(v => Utils.csvEscape(v)).join(",")).join("\n");
    Utils.downloadText("﻿" + csv, filename, "text/csv;charset=utf-8");
  }
};
