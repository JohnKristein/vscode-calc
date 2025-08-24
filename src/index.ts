// index.ts —— 扩展入口文件
// 负责：
// 1) 读取配置、创建输出通道与补全提供器实例；
// 2) 注册补全触发（等号/空格）与若干命令（Append/Replace × 光标/整行）；
// 3) 统一错误处理与临时高亮的清理；
// 4) 将“表达式计算”委托给 CalcProvider.calculateLine。

// VS Code API：命令注册、窗口/工作区对象、语言服务入口、位置与编辑器类型
import {
  commands,
  window,
  ExtensionContext,
  workspace,
  Position,
  languages,
  TextEditor,
} from 'vscode';
// 我们自己的补全/计算提供器，实现“识别表达式并返回 Append/Replace 两种补全”的核心逻辑
import { CalcProvider } from './calc-provider';

export function activate(context: ExtensionContext) {
  // 所有注册的可释放资源（命令、监听器、provider）都放到 subscriptions，
  // VS Code 关闭扩展时会统一清理，避免资源泄漏。
  const { subscriptions } = context;
  // 读取以 "calc" 为命名空间的配置（如 calc.suggestionOrder），
  // 供 CalcProvider 在排序候选时使用。
  const config = workspace.getConfiguration('calc');
  // 输出面板通道：把运行期异常、调试信息输出到 “输出 → calc”。
  // 出现问题时让用户能第一时间定位原因。
  const outputChannel = window.createOutputChannel('calc');

  // 统一错误处理：
  // - 捕获自计算/编辑操作抛出的异常；
  // - 输出 message 与 stack 到 outputChannel；
  // - 避免异常向外冒泡导致命令/提供器中断。
  const onError = (error: unknown) => {
    if (error instanceof Error) {
      outputChannel.appendLine(error.message);
      if (error.stack) outputChannel.appendLine(error.stack);
    } else {
      outputChannel.appendLine((error as any).toString().message);
    }
  };

  // 创建补全提供器：内部封装了 calculateLine(position, exprLine)
  // - 当触发字符出现时（见下文），VS Code 会调用其 provideCompletionItems；
  // - 返回两个 CompletionItem：Append（在等号后插入结果）与 Replace（用结果替换表达式）。
  const calcProvider = new CalcProvider(config, onError);

  // 注册补全 & 事件监听
  subscriptions.push(
    // 注册补全触发：
    // - 第 1 个参数 `'*'`：对所有语言生效；
    // - 第 2 个参数 `calcProvider`：具体提供补全的实现；
    // - 其后是“触发字符列表”：这里为 '=' 与 ' '（空格）。
    // 触发时机：用户键入等号或空格，VS Code 将把“光标所在行从开头到光标位置的文本”
    // 交给 calcProvider.provideCompletionItems，以便识别并计算结果。
    languages.registerCompletionItemProvider('*', calcProvider, '=', ' '),
    // 文档被打开时清理临时高亮（如果上一次触发后仍残留）。
    workspace.onDidOpenTextDocument(() => {
      calcProvider.clearHighlight().catch(onError);
    }),
    // 选区/光标变化时也清理临时高亮，保持界面整洁。
    window.onDidChangeTextEditorSelection(() => {
      calcProvider.clearHighlight().catch(onError);
    }),
  );

  // replaceResultsWithPositions：批量执行“在等号后追加”或“用结果替换表达式”
  // 参数：
  // - editor：当前编辑器
  // - positionsAndExpressions：若干 [光标位置, 该位置对应的表达式文本] 元组
  // - mode：'append' 或 'replace'
  // 流程：
  // 1) 针对每个位置，调用 calcProvider.calculateLine 解析并返回表达式范围/插入文本；
  // 2) append：在等号后或行尾插入计算结果；
  //    replace：用结果替换“表达式 + 等号”的范围；
  // 3) 统一通过一次 editBuilder.apply，保证原子性与撤销体验。
  async function replaceResultsWithPositions(
    editor: TextEditor,
    positionsAndExpressions: [Position, string][],
    mode: 'append' | 'replace',
  ) {
    await editor.edit((editBuilder) => {
      for (const [position, expression] of positionsAndExpressions) {
        // 对单行进行计算：让 provider 根据光标位置与行文本解析表达式并返回范围/结果
        const lineCalcResult = calcProvider.calculateLine(position, expression);
        if (lineCalcResult == null) {
          continue;
        }
        const { insertText, expressionWithEqualSignRange, expressionEndRange } =
          lineCalcResult;

        // 兼容两种书写：
        // - 用户已输入等号（形如 `expr =`）；
        // - 用户未输入等号（形如 `expr`），则自动补上 ` = ` 再追加结果。
        if (mode === 'append') {
          const endWithEqual = expression.trimEnd().endsWith('=');
          editBuilder.replace(
            expressionEndRange,
            endWithEqual ? insertText : ` = ${insertText}`,
          );
        // Replace 模式：用结果整体替换“表达式+等号”范围
        } else if (mode === 'replace') {
          editBuilder.replace(expressionWithEqualSignRange, insertText);
        }
      }
    });
  }

  // replaceResult：命令入口（四个命令公用）
  // - mode：'append' | 'replace'
  // - withCursor：true 表示“对每个光标独立处理光标前的子串”，false 表示“按整行处理”；
  // 保护：若当前有选区（不是纯光标），则直接返回以避免误改。
  async function replaceResult(
    mode: 'append' | 'replace',
    withCursor: boolean,
  ) {
    const editor = window.activeTextEditor;
    // 若没有活动编辑器，或当前存在选区（并非纯光标），则不执行
    if (!editor || !editor.selection.isEmpty) {
      return;
    }
    const doc = editor.document;

    let positionsAndExpressions;
    // withCursor=true：对每个光标单独取光标前的子串作为表达式
    if (withCursor) {
      // 对每个光标使用：该行从开头到光标处的子串作为“待计算表达式”。
      positionsAndExpressions = editor.selections.map(
        (selection) =>
          <[Position, string]>[
            selection.active,
            doc
              .lineAt(selection.active.line)
              .text.slice(0, selection.active.character),
          ],
      );
    // withCursor=false：去重行号后，取每一行的整行文本作为表达式
    } else {
      // 整行模式：对所有光标所在的“行号去重”后逐行处理，
      // 使用每一行的完整文本作为表达式，位置取行尾（line.range.end）。
      const uniqueLineNumbers = [
        ...new Set(editor.selections.map((selection) => selection.active.line)),
      ];
      positionsAndExpressions = uniqueLineNumbers.map((number) => {
        const line = doc.lineAt(number);
        return <[Position, string]>[line.range.end, line.text];
      });
    }
    await replaceResultsWithPositions(editor, positionsAndExpressions, mode);
  }

  // 命令注册：
  // - Append/Replace × WithCursor/整行，共 4 个命令；
  // - 命令实现均委派给 replaceResult，保证逻辑单一、便于维护与测试。
  subscriptions.push(
    // 适合“多光标同时计算”：每个光标使用自身前缀表达式，结果在等号后追加。
    // 追加（按光标）
    commands.registerTextEditorCommand('extension.calcAppendWithCursor', () => {
      replaceResult('append', true).catch(onError);
    }),
    // 适合“对若干行做批量结算”：以整行表达式为单位，在行尾或等号后追加结果。
    // 追加（按整行）
    commands.registerTextEditorCommand('extension.calcAppend', () => {
      replaceResult('append', false).catch(onError);
    }),
    // 与上类似，但把“表达式 + 等号”整体替换为结果文本。
    // 替换（按光标）
    commands.registerTextEditorCommand(
      'extension.calcReplaceWithCursor',
      () => {
        replaceResult('replace', true).catch(onError);
      },
    ),
    // 整行替换版本：逐行用计算结果替换整段表达式。
    // 替换（按整行）
    commands.registerTextEditorCommand('extension.calcReplace', () => {
      replaceResult('replace', false).catch(onError);
    }),
  );
}
