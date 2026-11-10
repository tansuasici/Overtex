import * as vscode from 'vscode';

import { TodoCommand, findTodoCommands } from './latex/highlights';
import { TexFiles } from './texFiles';

function rangeOf(todo: TodoCommand): vscode.Range {
  const r = todo.range;
  return new vscode.Range(r.startLine, r.startChar, r.endLine, r.endChar);
}

class FileItem extends vscode.TreeItem {
  constructor(
    readonly file: vscode.Uri,
    readonly todos: TodoItem[]
  ) {
    super(vscode.workspace.asRelativePath(file, true), vscode.TreeItemCollapsibleState.Expanded);
    this.id = `overtex.todos.${file.toString()}`;
    this.resourceUri = file;
    this.iconPath = vscode.ThemeIcon.File;
    this.description = String(todos.length);
    this.contextValue = 'file';
  }
}

class TodoItem extends vscode.TreeItem {
  constructor(file: vscode.Uri, todo: TodoCommand) {
    super(todo.text || `\\${todo.command}`);
    this.id = `overtex.todos.${file.toString()}.${todo.range.startLine}.${todo.range.startChar}`;
    this.description = `line ${todo.range.startLine + 1}${todo.command.toLowerCase() === 'fixme' ? ' · fixme' : ''}`;
    this.iconPath = new vscode.ThemeIcon('checklist');
    this.tooltip = new vscode.MarkdownString().appendCodeblock(`\\${todo.command}${todo.options ? `[${todo.options}]` : ''}{${todo.text}}`, 'latex');
    this.contextValue = 'todo';
    this.command = { command: 'vscode.open', title: 'Open', arguments: [file, { selection: rangeOf(todo) }] };
  }
}

type Node = FileItem | TodoItem;

class TodosProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly files: TexFiles<TodoCommand[]>) {}

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node instanceof FileItem) {
      return node.todos;
    }
    if (node) {
      return [];
    }
    const all = await this.files.all();
    return all
      .filter((f) => f.value.length > 0)
      .sort((a, b) => a.file.fsPath.localeCompare(b.file.fsPath))
      .map((f) => new FileItem(f.file, f.value.map((t) => new TodoItem(f.file, t))));
  }
}

/** The To-dos view: every \todo{…} and \fixme{…} in the workspace's .tex files. */
export function registerTodos(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;
  let provider: TodosProvider | undefined;
  const files = new TexFiles(findTodoCommands, () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider?.refresh(), 500);
  });
  provider = new TodosProvider(files);
  context.subscriptions.push(
    files,
    provider,
    { dispose: () => clearTimeout(timer) },
    vscode.window.createTreeView('overtex.todos', { treeDataProvider: provider }),
    vscode.commands.registerCommand('overtex.todos.refresh', () => provider?.refresh())
  );
}
