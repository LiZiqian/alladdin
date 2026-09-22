/* ========================================
   数字治理平台 V7 - 工具函数
   ======================================== */

const Utils = {
  /** Shared solid action icons; names and SVG paths are fixed, never user content. */
  iconHtml(name) {
    const paths = {
      copy: "M4 3h12v2H6v12H4V3Zm4 4h12v14H8V7Zm2 2v10h8V9h-8Z",
      trash: "M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 11H7L6 9Zm3 2 .5 7H11l-.5-7H9Zm4.5 0-.5 7h1.5l.5-7h-1.5Z",
      download: "M10 3h4v8h4l-6 6-6-6h4V3ZM4 16h3v4h10v-4h3v7H4v-7Z",
      upload: "m12 2 6 6h-4v9h-4V8H6l6-6ZM4 16h3v4h10v-4h3v7H4v-7Z"
    };
    if (!Object.prototype.hasOwnProperty.call(paths, name)) return "";
    return `<svg class="action-icon action-icon-${name}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${paths[name]}" fill-rule="evenodd"/></svg>`;
  },

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

  /** 展示时间使用本机时区并注明偏移；原始 ISO 时间仍用于存储和排序。 */
  dateTimeLabel(value) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = n => String(n).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} (UTC${offset >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)})`;
  },

  /** 今天日期 yyyy-MM-dd */
  today() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  },

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
    if (/^\d+$/.test(no)) return no.replace(/^0+(?=\d)/, "");
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

  /** 完整 CSV 解析：引号内换行属于字段，格式错误不能静默拆成其它记录。 */
  parseCsv(text) {
    const input = String(text ?? "").replace(/^\uFEFF/, "");
    const rows = [];
    let row = [], field = "", quoted = false, closed = false;
    const finishField = () => { row.push(field); field = ""; closed = false; };
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quoted) {
        if (ch === '"') {
          if (input[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else field += ch;
        continue;
      }
      if (ch === ',') { finishField(); continue; }
      if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && input[i + 1] === '\n') i++;
        finishField(); rows.push(row); row = [];
        continue;
      }
      if (closed) {
        if (ch === ' ' || ch === '\t') continue;
        throw new Error("CSV 引号结束后只能是逗号或换行");
      }
      if (ch === '"') {
        if (field.trim()) throw new Error("CSV 字段中的引号必须使用双引号转义");
        field = ""; quoted = true;
      } else field += ch;
    }
    if (quoted) throw new Error("CSV 字段的引号未闭合");
    if (row.length || field || closed || (input && !/[\r\n]$/.test(input))) {
      finishField(); rows.push(row);
    }
    return rows;
  },


  /** 解析测试用例CSV */
  parseTestCaseCsv(text) {
    const lines = Utils.parseCsv(text).filter(row => row.some(value => value.trim()));
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

  /** 解析项目人员CSV：格式为 "姓名/工号,人员类型" */
  parseProjectMembersCsv(text) {
    let lines;
    try { lines = Utils.parseCsv(text).filter(row => row.some(value => value.trim())); }
    catch (e) { return { error: e.message, rows: [] }; }
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
      if (cols.length !== 2) { skipped++; continue; }
      const parsed = Utils.parsePersonField(first);
      if (!parsed.ok) { skipped++; continue; }
      const { name, employeeNo } = parsed;
      // CSV uses the current template's explicit categories; typos cannot grant a role.
      const role = new Map([["测试人员", "tester"], ["开发人员", "developer"], ["其他人员", "other"],
        ["tester", "tester"], ["developer", "developer"], ["other", "other"]]).get(second);
      if (!role) { skipped++; continue; }

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
    const duplicateColumns = [];

    header.forEach((h, i) => {
      const hLower = Utils.normalizeImportHeader(h);
      for (const [key, names] of Object.entries(aliases)) {
        if (names.some(n => hLower === Utils.normalizeImportHeader(n))) {
          if (colMap[key] !== undefined) duplicateColumns.push(`${key}（第${colMap[key] + 1}、${i + 1}列）`);
          colMap[key] = i;
          break;
        }
      }
    });
    if (duplicateColumns.length) {
      return { error: `${sourceName}存在重复字段列：${duplicateColumns.join("、")}，请每个字段只保留一列`, rows: [] };
    }

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
      const exportedConfig = get('配置/制式');
      const exportedSkuName = get('SKU/版本');

      rows.push({
        importDate: Utils.parseSampleDateField(get('带入时间')),
        borrowDate: Utils.parseSampleDateField(get('借用时间')),
        stage: get('阶段') || 'Unknown',
        standard: exportedConfig || get('方案') || '',
        platform: get('型号/方案') || '',
        skuName: exportedSkuName || '',
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
    try { return Utils.parseSampleImportMatrix(Utils.parseCsv(text), "CSV文件"); }
    catch (e) { return { error: e.message || String(e), rows: [] }; }
  },

  async parseSampleImportXlsx(buffer) {
    try {
      const files = await Utils.unzipXlsxFiles(buffer);
      const sharedStrings = Utils.parseXlsxSharedStrings(files["xl/sharedStrings.xml"] || "");
      const styles = Utils.parseXlsxDateStyles(files["xl/styles.xml"] || "");
      const sheet = Utils.firstXlsxWorksheet(files);
      const matrix = Utils.parseXlsxSheet(files[sheet.path], sharedStrings, styles, { date1904: sheet.date1904 });
      return Utils.parseSampleImportMatrix(matrix, "XLSX模板");
    } catch (e) {
      return { error: e.message || String(e), rows: [] };
    }
  },

  async unzipXlsxFiles(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const maxFileBytes = 64 * 1024 * 1024, maxTotalBytes = 128 * 1024 * 1024;
    if (bytes.length > maxFileBytes) throw new Error("XLSX文件超过64MB上限，请拆分后导入");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("不是有效的XLSX文件");
    const total = view.getUint16(eocd + 10, true);
    let ptr = view.getUint32(eocd + 16, true);
    const directoryEnd = ptr + view.getUint32(eocd + 12, true);
    const directoryStart = ptr;
    if (view.getUint16(eocd + 4, true) || view.getUint16(eocd + 6, true)
      || total !== view.getUint16(eocd + 8, true) || total > 20000 || directoryEnd > eocd) {
      throw new Error("XLSX目录结构损坏或使用了不支持的分卷/ZIP64格式");
    }
    const decoder = new TextDecoder("utf-8");
    const files = Object.create(null);
    const names = new Set();
    let totalBytes = 0;

    for (let i = 0; i < total; i++) {
      if (ptr + 46 > directoryEnd || view.getUint32(ptr, true) !== 0x02014b50) throw new Error("XLSX目录结构损坏");
      const flags = view.getUint16(ptr + 8, true);
      const method = view.getUint16(ptr + 10, true);
      const checksum = view.getUint32(ptr + 16, true);
      const compressedSize = view.getUint32(ptr + 20, true);
      const uncompressedSize = view.getUint32(ptr + 24, true);
      const fileNameLen = view.getUint16(ptr + 28, true);
      const extraLen = view.getUint16(ptr + 30, true);
      const commentLen = view.getUint16(ptr + 32, true);
      const localOffset = view.getUint32(ptr + 42, true);
      if (ptr + 46 + fileNameLen + extraLen + commentLen > directoryEnd || flags & 1
        || view.getUint16(ptr + 34, true) || localOffset + 30 > directoryStart
        || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
        throw new Error("XLSX目录越界、文件已加密或使用ZIP64格式");
      }
      const nameBytes = bytes.slice(ptr + 46, ptr + 46 + fileNameLen);
      const fileName = decoder.decode(nameBytes);
      const nameKey = fileName.toLowerCase();
      if (!fileName || fileName.includes("\\") || /[\x00-\x1f:]/.test(fileName)
        || fileName.replace(/\/$/, "").split("/").some(part => !part || part === "." || part === "..") || names.has(nameKey)) {
        throw new Error("XLSX包含重复或无效的内部文件路径");
      }
      names.add(nameKey);

      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("XLSX文件头损坏");
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      if (dataStart + compressedSize > directoryStart || view.getUint16(localOffset + 8, true) !== method
        || view.getUint16(localOffset + 6, true) !== flags
        || (!(flags & 8) && (view.getUint32(localOffset + 14, true) !== checksum
          || view.getUint32(localOffset + 18, true) !== compressedSize || view.getUint32(localOffset + 22, true) !== uncompressedSize))
        || decoder.decode(bytes.subarray(localOffset + 30, localOffset + 30 + localNameLen)) !== fileName) {
        throw new Error("XLSX文件头与目录不一致或数据越界");
      }
      ptr += 46 + fileNameLen + extraLen + commentLen;
      if (!/\.(xml|rels)$/i.test(fileName)) continue;
      if (uncompressedSize > maxFileBytes || totalBytes + uncompressedSize > maxTotalBytes) {
        throw new Error("XLSX解压内容过大，请拆分后导入");
      }
      const compressed = bytes.slice(dataStart, dataStart + compressedSize);
      let dataBytes;
      if (method === 0) {
        dataBytes = compressed;
      } else if (method === 8) {
        dataBytes = await Utils.inflateRawBytes(compressed, uncompressedSize);
      } else {
        throw new Error("XLSX使用了不支持的压缩方式");
      }
      if (dataBytes.length !== uncompressedSize || Utils.xlsxCrc32(dataBytes) !== checksum) throw new Error("XLSX内容校验失败，文件可能已损坏");
      totalBytes += dataBytes.length;
      files[fileName] = decoder.decode(dataBytes);
    }
    if (ptr !== directoryEnd) throw new Error("XLSX目录长度不一致");
    return files;
  },

  xlsxCrc32(bytes) {
    if (!Utils._xlsxCrcTable) {
      Utils._xlsxCrcTable = Uint32Array.from({ length: 256 }, (_, index) => {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        return value >>> 0;
      });
    }
    let crc = 0xffffffff;
    for (const byte of bytes) crc = Utils._xlsxCrcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  },

  async inflateRawBytes(compressed, maxOutputBytes = 64 * 1024 * 1024) {
    const root = typeof globalThis !== "undefined" ? globalThis : window;
    const NativeDecompressionStream = root.DecompressionStream || root.window?.DecompressionStream;
    let decompressor;
    if (NativeDecompressionStream && root.Blob) {
      try { decompressor = new NativeDecompressionStream("deflate-raw"); }
      catch (_) { /* Older browsers implement the API without deflate-raw. */ }
    }
    if (decompressor) {
      const reader = new root.Blob([compressed]).stream().pipeThrough(decompressor).getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > maxOutputBytes) {
            await reader.cancel();
            throw new Error("XLSX解压内容超过声明大小或安全上限");
          }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const result = new Uint8Array(length);
      let offset = 0;
      chunks.forEach(chunk => { result.set(chunk, offset); offset += chunk.length; });
      return result;
    }
    return Utils.inflateRawBytesFallback(compressed, maxOutputBytes);
  },

  inflateRawBytesFallback(compressed, maxOutputBytes = 64 * 1024 * 1024) {
    const input = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
    let bitPos = 0;
    let output = new Uint8Array(Math.min(16384, maxOutputBytes));
    let outputLength = 0;
    const append = value => {
      if (outputLength >= maxOutputBytes) throw new Error("XLSX解压内容超过声明大小或安全上限");
      if (outputLength === output.length) {
        const next = new Uint8Array(Math.min(Math.max(1, output.length * 2), maxOutputBytes));
        next.set(output); output = next;
      }
      output[outputLength++] = value;
    };
    const lengthBase = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
    const lengthExtra = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
    const distBase = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const distExtra = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

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
        if (code + counts[bits] > (1 << bits)) throw new Error("XLSX压缩编码树损坏");
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
      if (hlit > 286) throw new Error("XLSX压缩编码树损坏");
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
          if (!lengths.length) throw new Error("XLSX压缩重复编码损坏");
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
        if (lengths.length > hlit + hdist) throw new Error("XLSX压缩重复编码越界");
      }
      if (!lengths[256]) throw new Error("XLSX压缩数据缺少结束编码");
      return {
        literalTree: buildHuffman(lengths.slice(0, hlit)),
        distanceTree: buildHuffman(lengths.slice(hlit, hlit + hdist))
      };
    };
    const inflateCompressedBlock = (literalTree, distanceTree) => {
      while (true) {
        const symbol = decodeSymbol(literalTree);
        if (symbol < 256) {
          append(symbol);
        } else if (symbol === 256) {
          return;
        } else if (symbol <= 285) {
          const idx = symbol - 257;
          if (idx >= lengthBase.length) throw new Error("XLSX压缩长度损坏");
          const length = lengthBase[idx] + readBits(lengthExtra[idx]);
          const distSymbol = decodeSymbol(distanceTree);
          if (distSymbol >= distBase.length) throw new Error("XLSX压缩距离损坏");
          const distance = distBase[distSymbol] + readBits(distExtra[distSymbol]);
          if (!distance || distance > outputLength) throw new Error("XLSX压缩距离损坏");
          for (let i = 0; i < length; i++) append(output[outputLength - distance]);
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
        for (let i = 0; i < len; i++) append(readBits(8));
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
    return output.slice(0, outputLength);
  },

  parseXlsxXml(xml) {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("XLSX包含不支持的XML实体声明");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("XLSX的XML内容已损坏");
    return doc;
  },

  xlsxElements(node, name) {
    return Array.from(node.getElementsByTagNameNS("*", name));
  },

  firstXlsxWorksheet(files) {
    const workbookXml = files["xl/workbook.xml"];
    const relationshipsXml = files["xl/_rels/workbook.xml.rels"];
    if (!workbookXml && !relationshipsXml) {
      const path = Object.keys(files).filter(name => /^xl\/worksheets\/[^/]+\.xml$/i.test(name))
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0];
      if (!path) throw new Error("XLSX中没有找到工作表");
      return { path, date1904: false };
    }
    if (!workbookXml || !relationshipsXml) throw new Error("XLSX缺少工作簿或工作表关系文件");
    const workbook = Utils.parseXlsxXml(workbookXml);
    const relationships = Utils.xlsxElements(Utils.parseXlsxXml(relationshipsXml), "Relationship");
    const date1904 = /^(1|true)$/i.test(Utils.xlsxElements(workbook, "workbookPr")[0]?.getAttribute("date1904") || "");
    const sheets = Utils.xlsxElements(workbook, "sheet");
    const ordered = [...sheets.filter(sheet => !/^(hidden|veryHidden)$/.test(sheet.getAttribute("state") || "")),
      ...sheets.filter(sheet => /^(hidden|veryHidden)$/.test(sheet.getAttribute("state") || ""))];
    for (const sheet of ordered) {
      const id = sheet.getAttribute("r:id") || Array.from(sheet.attributes).find(attr => attr.localName === "id")?.value;
      const relationship = relationships.find(item => item.getAttribute("Id") === id);
      if (!relationship) throw new Error("XLSX工作表关系缺失");
      if (!/\/worksheet$/.test(relationship.getAttribute("Type") || "")) continue;
      if (relationship.getAttribute("TargetMode") === "External") throw new Error("XLSX不能导入外部工作表");
      const target = relationship.getAttribute("Target") || "";
      if (!target || target.includes("\\") || /[:?#\x00-\x1f]/.test(target)) throw new Error("XLSX工作表路径无效");
      const segments = target.startsWith("/") ? [] : ["xl"];
      for (const segment of target.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
          if (!segments.length) throw new Error("XLSX工作表路径越界");
          segments.pop();
        } else segments.push(segment);
      }
      let path = segments.join("/");
      if (!Object.hasOwn(files, path)) {
        try { path = decodeURIComponent(path); } catch (_) { throw new Error("XLSX工作表路径无效"); }
      }
      if (!Object.hasOwn(files, path)) throw new Error("XLSX工作表文件缺失");
      return { path, date1904 };
    }
    throw new Error("XLSX中没有找到工作表");
  },

  xlsxRichText(node) {
    return Utils.xlsxElements(node, "t").filter(text => {
      for (let parent = text.parentNode; parent && parent !== node; parent = parent.parentNode) {
        if (parent.localName === "rPh") return false;
      }
      return true;
    }).map(text => text.textContent || "").join("");
  },

  parseXlsxSharedStrings(xml) {
    if (!xml) return [];
    const doc = Utils.parseXlsxXml(xml);
    return Utils.xlsxElements(doc, "si").map(si => Utils.xlsxRichText(si));
  },

  parseXlsxDateStyles(xml) {
    const dateStyleIndexes = new Set();
    if (!xml) return dateStyleIndexes;
    const doc = Utils.parseXlsxXml(xml);
    const customDateIds = new Set();
    Utils.xlsxElements(doc, "numFmt").forEach(fmt => {
      const id = fmt.getAttribute("numFmtId");
      const code = (fmt.getAttribute("formatCode") || "").replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, "");
      if (/[yd年月日]/i.test(code) || (/m/i.test(code) && !/[hs]/i.test(code))) customDateIds.add(id);
    });
    const builtInDateIds = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58].map(String));
    const cellXfs = Utils.xlsxElements(doc, "cellXfs")[0];
    const xfs = cellXfs ? Utils.xlsxElements(cellXfs, "xf") : [];
    dateStyleIndexes.styleCount = xfs.length;
    Array.from(xfs).forEach((xf, idx) => {
      const numFmtId = xf.getAttribute("numFmtId");
      if (builtInDateIds.has(numFmtId) || customDateIds.has(numFmtId)) dateStyleIndexes.add(String(idx));
    });
    return dateStyleIndexes;
  },

  parseXlsxSheet(xml, sharedStrings = [], dateStyleIndexes = new Set(), { date1904 = false } = {}) {
    const doc = Utils.parseXlsxXml(xml);
    const out = [];
    const seenRows = new Set();
    let previousRow = 0;
    const sheetRows = Utils.xlsxElements(doc, "row").map(row => {
      const rawIndex = row.getAttribute("r");
      const index = rawIndex ? Number(rawIndex) : previousRow + 1;
      if (!Number.isInteger(index) || index < 1 || index > 1048576 || seenRows.has(index)) throw new Error("XLSX行号无效或重复");
      seenRows.add(index); previousRow = index;
      return { row, index };
    }).sort((a, b) => a.index - b.index);
    sheetRows.forEach(({ row, index }) => {
      const values = [];
      let nextColumn = 0;
      Utils.xlsxElements(row, "c").forEach(cell => {
        const ref = cell.getAttribute("r") || "";
        let col = nextColumn;
        if (ref) {
          const match = ref.match(/^([A-Za-z]{1,3})([1-9]\d*)$/);
          if (!match || Number(match[2]) !== index) throw new Error(`XLSX单元格引用无效：${ref}`);
          col = 0;
          for (const ch of match[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
          col--;
        }
        if (col < 0 || col >= 16384 || Object.hasOwn(values, col)) throw new Error(`XLSX单元格列号无效或重复：${ref}`);
        nextColumn = col + 1;
        const type = cell.getAttribute("t");
        const style = cell.getAttribute("s");
        const valueNode = Utils.xlsxElements(cell, "v")[0];
        const v = valueNode?.textContent || "";
        if (Utils.xlsxElements(cell, "f").length && (!valueNode || (!v && type !== "str"))) {
          throw new Error(`XLSX单元格${ref || index}的公式没有计算结果，请用Excel重新计算并保存后导入`);
        }
        if (type === "e") throw new Error(`XLSX单元格${ref || index}包含错误值${v}，请修正后导入`);
        if (style && (!/^\d+$/.test(style) || (Number.isInteger(dateStyleIndexes.styleCount) && Number(style) >= dateStyleIndexes.styleCount))) {
          throw new Error(`XLSX单元格${ref || index}的样式引用无效`);
        }
        let value = "";
        if (type === "s") {
          if (!/^\d+$/.test(v) || Number(v) >= sharedStrings.length) throw new Error(`XLSX单元格${ref || index}的文本引用无效`);
          value = sharedStrings[Number(v)];
        } else if (type === "inlineStr") {
          value = Utils.xlsxRichText(cell);
        } else if (dateStyleIndexes.has(style) && v && !Number.isNaN(Number(v))) {
          value = Utils.excelSerialToDate(Number(v), date1904);
        } else {
          value = v;
        }
        values[col] = value;
      });
      out.push(values);
    });
    return out;
  },

  excelSerialToDate(serial, date1904 = false) {
    if (!Number.isFinite(serial) || serial < 0 || serial >= 2958466 - (date1904 ? 1462 : 0)) throw new Error("XLSX日期序列超出有效范围");
    const days = Math.floor(serial);
    if (!date1904 && days === 60) throw new Error("XLSX日期为不存在的1900-02-29，请修正后导入");
    const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
    const d = new Date(epoch + (days - (!date1904 && days > 60 ? 1 : 0)) * 86400000);
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
