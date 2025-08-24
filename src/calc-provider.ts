// calc-provider.ts —— 计算/补全提供器
// 职责：
// 1) 在等号触发时，识别光标前的表达式；
// 2) 先尝试“日期区间差值”解析，成功则返回 days/months/years；
// 3) 未命中日期格式时，回退到外部库 editor-calc 做数学表达式计算；
// 4) 生成两条补全项（Append/Replace），并支持多光标同步处理；
// 5) 提供临时高亮，帮助用户确认被计算的表达式范围。

// VS Code API：补全协议、文档/位置/范围类型、编辑操作与 UI（高亮、输出）
import {
  CompletionItemProvider,
  CompletionContext,
  TextEditorDecorationType,
  WorkspaceConfiguration,
  TextDocument,
  CompletionItem,
  CompletionItemKind,
  Range,
  Position,
  CancellationToken,
  window,
  TextEdit,
} from 'vscode';
// 外部数学计算库：把“非日期”的表达式交给它解析与求值
import { calculate } from 'editor-calc';
// 日期解析库 dayjs：开启 customParseFormat 插件以支持多格式严格解析
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
dayjs.extend(customParseFormat);
// CalcProvider：实现 CompletionItemProvider 接口，供 index.ts 注册与调用
export class CalcProvider implements CompletionItemProvider {
  public enableActive: boolean;

  constructor(
    public config: WorkspaceConfiguration,
    private onError: (error: unknown) => any,
  ) {
    // 是否强制在未输入等号时也启用补全（当前默认关闭，仅在行尾 '=' 时触发）
    this.enableActive = false;
    // 临时高亮样式：在识别到表达式后用虚线边框标出对应范围
    this.decorationType = window.createTextEditorDecorationType({
      dark: {
        border: '1px dashed gray',
      },
      light: {
        border: '1px dashed black',
      },
    });
  }

  // 高亮指定范围：配合 provideCompletionItems 前后的 UI 提示
  public async highlight(range: Range) {
    const editor = window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.decorationType, [range]);
    }
  }

  // 清理高亮：在文档/光标变化时调用，避免残留装饰
  public async clearHighlight() {
    const editor = window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.decorationType, []);
    }
  }

  // 私有助手：仅检测“日期区间”并计算差值，同时构造表达式范围（不返回组合字符串）
  private detectDateRange(
    position: Position,
    exprLine: string,
  ): {
    skip: number;
    expressionRange: Range;
    expressionWithEqualSignRange: Range;
    expressionEndRange: Range;
    yearsF: number; // 年差（小数）
    monthsF: number; // 月差（小数）
    days: number; // 天差（整数）
  } | null {
    const dateToken =
      '(?:\\d{4}[.-]\\d{1,2}[.-]\\d{1,2}|\\d{1,2}[.-]\\d{1,2}[.-]\\d{4})';
    const exprForDate = exprLine.replace(/[\s=]+$/, '');
    const dateRangeRe = new RegExp(
      `(${dateToken})\\s+(?:~|-)\\s+(${dateToken})\\s*$`,
    );
    const m = exprForDate.match(dateRangeRe);
    if (!m) return null;

    const rangeText: string = m[0];
    const raw1: string = m[1];
    const raw2: string = m[2];

    const formats = [
      'YYYY-M-D', 'YYYY.M.D',
      'D-M-YYYY', 'D.M.YYYY',
      'M-D-YYYY', 'M.D.YYYY',
      'YYYY-MM-DD', 'YYYY.MM.DD',
      'DD-MM-YYYY', 'DD.MM.YYYY',
      'MM-DD-YYYY', 'MM.DD.YYYY',
    ];
    const parseStrict = (s: string): dayjs.Dayjs | null => {
      for (const f of formats) {
        const d = dayjs(s, f, true);
        if (d.isValid()) return d;
      }
      return null;
    };
    const d1 = parseStrict(raw1);
    const d2 = parseStrict(raw2);
    if (!d1 || !d2) return null;

    const days: number = d2.diff(d1, 'day');
    const monthsF: number = d2.diff(d1, 'month', true);
    const yearsF: number = d2.diff(d1, 'year', true);

    const skip = exprForDate.lastIndexOf(rangeText);
    const formulaRaw = exprLine.slice(skip);
    const leftMatches = formulaRaw.match(/^\s+/);
    const leftEmpty = leftMatches ? leftMatches[0].length : 0;
    const rightMatches = formulaRaw.match(/[\s=]+$/);
    const rightEmpty = rightMatches ? rightMatches[0].length : 0;

    return {
      skip,
      expressionRange: new Range(
        position.line,
        skip + leftEmpty,
        position.line,
        position.character - rightEmpty,
      ),
      expressionWithEqualSignRange: new Range(
        position.line,
        skip + leftEmpty,
        position.line,
        position.character,
      ),
      expressionEndRange: new Range(
        position.line,
        position.character,
        position.line,
        position.character,
      ),
      yearsF,
      monthsF,
      days,
    };
  }

  public calculateLine(
    position: Position,
    exprLine: string,
  ): {
    skip: number;
    result: string;
    insertText: string;
    expressionRange: Range;
    expressionWithEqualSignRange: Range;
    expressionEndRange: Range;
  } | null {
    // 计算“当前行表达式”的核心方法：
    // 输入：光标位置 + 该行从开头到光标的文本（exprLine）
    // 输出：
    // - skip：从行首到表达式起点的偏移；
    // - result/insertText：显示与插入用的结果字符串；
    // - 三个 Range：表达式区间、包含等号的区间、以及插入位置（行尾/等号后）。

    console.log("[calc debug] exprLine:", JSON.stringify(exprLine));

    // [分支1] 日期区间差值识别：
    // 设计目标：支持 `YYYY-M-D` / `D-M-YYYY` / `M-D-YYYY`，分隔符可为 `-` 或 `.`，
    // 且两个日期之间以“空格 + (~|-) + 空格”连接；末尾允许有空白/等号，由上方 exprForDate 去尾处理。
    // dateToken：一个“日期样式”的可选片段（年在前或年在后，两种形态），用于组装整体正则
    const dateToken =
      '(?:\\d{4}[.-]\\d{1,2}[.-]\\d{1,2}|\\d{1,2}[.-]\\d{1,2}[.-]\\d{4})';

    const exprForDate = exprLine.replace(/[\s=]+$/, '');
    console.log("[calc debug] exprForDate:", JSON.stringify(exprForDate));

    const dateRangeRe = new RegExp(
      `(${dateToken})\\s+(?:~|-)\\s+(${dateToken})\\s*$`,
    );
    console.log("[calc debug] dateRangeRe:", dateRangeRe.source);

    const m = exprForDate.match(dateRangeRe);
    console.log("[calc debug] match:", m && {0: m[0], 1: m[1], 2: m[2]});

    if (m) {
      // 命中后：m[0] 为整段区间文本，m[1]/m[2] 为左右日期原始字符串
      const rangeText: string = m[0];
      const raw1: string = m[1];
      const raw2: string = m[2];
      console.log("[calc debug] raw1:", raw1, "raw2:", raw2);

      // 支持的日期格式集合（严格模式）：
      // - 允许 1-2 位月份/日期；
      // - 同时列出 '-' 与 '.' 版本，以覆盖多写法。
      const formats = [
        'YYYY-M-D', 'YYYY.M.D',
        'D-M-YYYY', 'D.M.YYYY',
        'M-D-YYYY', 'M.D.YYYY',
        'YYYY-MM-DD', 'YYYY.MM.DD',
        'DD-MM-YYYY', 'DD.MM.YYYY',
        'MM-DD-YYYY', 'MM.DD.YYYY',
      ];

      // 严格解析助手：逐个格式尝试，返回合法的 Dayjs 对象，否则 null
      const parseStrict = (s: string): dayjs.Dayjs | null => {
        for (const f of formats) {
          const d = dayjs(s, f, true);
          if (d.isValid()) return d;
        }
        return null;
      };
      // 分别解析左右日期：若任一无效，则放弃日期分支，后续走数学表达式
      const d1 = parseStrict(raw1);
      const d2 = parseStrict(raw2);
      console.log("[calc debug] d1 valid:", !!d1, "d2 valid:", !!d2);

      // 两端均有效：计算差值（day/month/year）——不做“包含端点 +1”的处理，保证可预期
      if (d1 && d2) {
        // 以 Dayjs.diff 精确计算差值；月份与年差为“日历差”（非四舍五入的天数换算）
        const days: number = d2.diff(d1, 'day');
        const months: number = d2.diff(d1, 'month');
        const years: number = d2.diff(d1, 'year');
        console.log("[calc debug] diffs:", {days, months, years});

        // 结果字符串：供补全项 label/detail 与插入文本复用
        const resultStr = `days=${String(days)}, months=${String(months)}, years=${String(years)}`;
        // 重新计算表达式起点：基于去尾后的文本定位起点（与原行下标一致，因为只裁剪了末尾）
        const skip = exprForDate.lastIndexOf(rangeText);

        // 下面三段用于微调左右空白，以得到更准确的表达式/等号范围
        const formulaRaw = exprLine.slice(skip);
        const leftMatches = formulaRaw.match(/^\s+/);
        const leftEmpty = leftMatches ? leftMatches[0].length : 0;
        const rightMatches = formulaRaw.match(/[\s=]+$/);
        const rightEmpty = rightMatches ? rightMatches[0].length : 0;

        // 若行尾实际存在“空格 + =”，则在结果前补一个空格，形成 ` = <result>` 的插入体验
        const insertText = exprLine.endsWith(' =')
          ? ` ${resultStr}`
          : resultStr;

        // 返回本分支的所有产物：范围 + 结果文本；
        // 外层调用将据此构造 Append/Replace 两条补全项
        return {
          skip,
          result: resultStr,
          insertText,
          expressionRange: new Range(
            position.line,
            skip + leftEmpty,
            position.line,
            position.character - rightEmpty,
          ),
          expressionWithEqualSignRange: new Range(
            position.line,
            skip + leftEmpty,
            position.line,
            position.character,
          ),
          expressionEndRange: new Range(
            position.line,
            position.character,
            position.line,
            position.character,
          ),
        };
      }
    }

    // [分支2] 数学表达式回退：调用外部库 editor-calc 解析
    // 任何异常（非法表达式等）都会在 onError 中记录并放弃本次补全
    let skip, result;
    try {
      ({ skip, result } = calculate(exprLine));
    } catch (error) {
      this.onError(error);
      return null;
    }
    // 与日期分支相同：对左右空白与等号做范围修正
    const formulaRaw = exprLine.slice(skip);
    const leftMatches = formulaRaw.match(/^\s+/);
    const leftEmpty = leftMatches ? leftMatches[0].length : 0;
    const rightMatches = formulaRaw.match(/[\s=]+$/);
    const rightEmpty = rightMatches ? rightMatches[0].length : 0;

    // 若行尾实际存在“空格 + =”，则在结果前补一个空格，形成 ` = <result>` 的插入体验
    const insertText = exprLine.endsWith(' =') ? ` ${result}` : result;

    // 返回数学分支的产物：与日期分支结构一致，便于上层统一处理
    return {
      skip,
      result,
      insertText,
      expressionRange: new Range(
        position.line,
        skip + leftEmpty,
        position.line,
        position.character - rightEmpty,
      ),
      expressionWithEqualSignRange: new Range(
        position.line,
        skip + leftEmpty,
        position.line,
        position.character,
      ),
      expressionEndRange: new Range(
        position.line,
        position.character,
        position.line,
        position.character,
      ),
    };
  }

  // 多光标支持：为除“主光标”之外的每个光标计算各自的表达式与结果
  private getCompletionResultsFromExtraCursors(document: TextDocument): {
    additionalReplacements: Range[];
    additionalTextInserts: string[];
    additionalResults: string[];
  } {
    // 收集附加编辑：
    // - additionalReplacements：每个光标对应的“表达式 + 等号”范围；
    // - additionalTextInserts：Append 分支在等号后插入的文本；
    // - additionalResults：Replace 分支用于替换的结果文本。
    const additionalReplacements = [];
    const additionalTextInserts = [];
    const additionalResults = [];

    const editor = window.activeTextEditor;
    if (editor) {
      // 从第二个光标开始遍历：主光标在外层已处理，这里只准备“附加编辑”
      for (const selection of editor.selections.slice(1)) {
        const position = selection.active;
        const exprLine = document.getText(
          new Range(new Position(position.line, 0), position),
        );
        const lineCalcResult = this.calculateLine(position, exprLine);
        if (lineCalcResult == null) {
          continue;
        }
        const { expressionWithEqualSignRange, insertText, result } =
          lineCalcResult;
        additionalReplacements.push(expressionWithEqualSignRange);
        additionalTextInserts.push(insertText);
        additionalResults.push(result);
      }
    }

    return { additionalReplacements, additionalTextInserts, additionalResults };
  }

  // provideCompletionItems：补全入口
  // 1) 获取“行首到光标”的文本 exprLine；
  // 2) 若未启用强制模式且行尾不是 '='，直接返回空（避免噪音提示）；
  // 3) 调用 calculateLine，得到范围与结果；
  // 4) 生成 Append/Replace 两条补全项，并结合多光标准备 additionalTextEdits。
  public async provideCompletionItems(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    _context: CompletionContext,
  ): Promise<CompletionItem[]> {
    const exprLine = document.getText(
      new Range(new Position(position.line, 0), position),
    );
    if (!this.enableActive && !exprLine.trimRight().endsWith('=')) {
      return [];
    }

    // 若是“日期区间”，返回 3 条补全（年/⽉/天），并采用 Append 行为
    const dateInfo = this.detectDateRange(position, exprLine);
    if (dateInfo) {
      const { expressionRange, expressionWithEqualSignRange, expressionEndRange, yearsF, monthsF, days } = dateInfo;

      this.clearHighlight().catch(this.onError);
      this.highlight(expressionRange).catch(this.onError);

      const yearsLabel = `${yearsF.toFixed(2)} 年`;
      const monthsLabel = `${monthsF.toFixed(2)} 月`;
      const daysLabel = `${days} 天`;

      const makeAppendItem = (label: string): CompletionItem => ({
        label,
        kind: CompletionItemKind.Constant,
        detail: 'calc append',
        documentation: `\`${exprLine.trimStart()} ${label}\``,
        range: expressionEndRange,
        additionalTextEdits: [
          TextEdit.insert(expressionWithEqualSignRange.end, ` ${label}`),
        ],
        insertText: '',
      });

      // 顺序：年 → 月 → 天
      return [makeAppendItem(yearsLabel), makeAppendItem(monthsLabel), makeAppendItem(daysLabel)];
    }

    const lineCalcResult = this.calculateLine(position, exprLine);
    if (lineCalcResult == null) {
      return [];
    }
    const {
      skip,
      result,
      expressionRange,
      expressionWithEqualSignRange,
      expressionEndRange,
      insertText,
    } = lineCalcResult;

    // 先清理旧高亮，再为当前表达式范围添加高亮（视觉确认）
    this.clearHighlight().catch(this.onError);

    this.highlight(expressionRange).catch(this.onError);

    const { additionalReplacements, additionalTextInserts, additionalResults } =
      this.getCompletionResultsFromExtraCursors(document);
    // 若存在多光标，文档说明中追加 (multiple) 以提示“本次操作将作用于多个位置”
    const documentationPostfix =
      additionalResults.length > 0 ? ' (multiple)' : '';

    // 补全项1：Append（在等号后追加结果；多光标通过 additionalTextEdits 一并插入）
    const appendItem: CompletionItem = {
      label: result,
      kind: CompletionItemKind.Constant,
      detail: `calc append${documentationPostfix}`,
      // 在说明中展示“表达式 + 结果”的预览，便于用户确认
      documentation: `\`${exprLine
        .slice(skip)
        .trimStart()}${insertText}\`${documentationPostfix}`,
      range: expressionEndRange,
      // additionalTextEdits inserts text after '=' for all cursors
      additionalTextEdits: [
        TextEdit.insert(expressionWithEqualSignRange.end, insertText),
        ...additionalReplacements.map((replacementRange, i) =>
          TextEdit.insert(replacementRange.end, additionalTextInserts[i]),
        ),
      ],
      insertText: '',
    };

    // 补全项2：Replace（用结果整体替换表达式 + 等号；多光标同理）
    const replaceItem: CompletionItem = {
      label: result,
      kind: CompletionItemKind.Constant,
      detail: `calc replace${documentationPostfix}`,
      documentation: `\`${result}\`${documentationPostfix}`,
      // additionalTextEdits replaces the expression with result for all cursors
      additionalTextEdits: [
        TextEdit.replace(expressionWithEqualSignRange, result),
        ...additionalReplacements.map((replacementRange, i) =>
          TextEdit.replace(replacementRange, additionalResults[i]),
        ),
      ],
      insertText: '',
    };

    // 读取用户设置：calc.suggestionOrder（appendFirst | replaceFirst | autoRecent）
    const order = this.config.get<string>('suggestionOrder', 'appendFirst');

    // 根据设置决定补全项的排序权重（sortText），以控制列表中的显示顺序
    let items: CompletionItem[];
    if (order === 'replaceFirst') {
      // Make replace come first and dominate sort order
      replaceItem.sortText = '0000';
      appendItem.sortText = '0001';
      items = [replaceItem, appendItem];
    } else if (order === 'appendFirst') {
      // Keep append first (current behavior) with explicit sort
      appendItem.sortText = '0000';
      replaceItem.sortText = '0001';
      items = [appendItem, replaceItem];
    } else {
      // autoRecent: let VS Code's suggestSelection decide; avoid forcing sort order
      items = [appendItem, replaceItem];
    }

    return items;
  }

  // 可选的“补全项解析”阶段：本扩展不需要延迟填充，直接返回即可
  async resolveCompletionItem(
    item: CompletionItem,
    _token: CancellationToken,
  ): Promise<CompletionItem> {
    return item;
  }
}