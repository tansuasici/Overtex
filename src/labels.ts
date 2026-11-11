import * as vscode from 'vscode';
import * as path from 'path';

import { activeTexEditor } from './addCitation';
import {
  LabelEntry,
  LabelKind,
  LabelScan,
  LabelSite,
  groupLabels,
  labelSummary,
  mergeLabels,
  occurrenceAt,
  refCommand,
  renameProblem,
  scanLabels,
} from './latex/labels';
import { TexFiles } from './texFiles';

const TEX_LANGUAGES = new Set(['latex', 'tex']);
const TEX_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file', language: 'latex' },
  { scheme: 'file', language: 'tex' },
];
const KIND_ICONS: Record<LabelKind, string> = {
  Sections: 'symbol-namespace',
  Figures: 'file-media',
  Tables: 'table',
  Equations: 'symbol-operator',
  Theorems: 'law',
  Code: 'code',
  Other: 'tag',
};

function rangeOf(site: LabelSite): vscode.Range {
  return new vscode.Range(site.line, site.start, site.line, site.end);
}

function locationOf(site: LabelSite): vscode.Location {
  return new vscode.Location(vscode.Uri.file(site.file), rangeOf(site));
}

function openCommand(site: LabelSite): vscode.Command {
  return { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(site.file), { selection: rangeOf(site) }] };
}

function warningIcon(): vscode.ThemeIcon {
  return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
}

class GroupItem extends vscode.TreeItem {
  constructor(
    readonly group: string,
    readonly labels: LabelItem[]
  ) {
    super(group, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `overtex.labels.${group}`;
    this.description = String(labels.length);
    this.contextValue = 'group';
  }
}

class LabelItem extends vscode.TreeItem {
  constructor(
    readonly entry: LabelEntry,
    group: string
  ) {
    super(entry.key, vscode.TreeItemCollapsibleState.Collapsed);
    this.id = `overtex.labels.${group}.${entry.key}`;
    const site = entry.definitions[0] ?? entry.references[0];
    const summary = labelSummary(entry);
    this.description = entry.definitions[0] ? `${summary} · ${path.basename(site.file)}` : summary;
    this.iconPath = entry.definitions.length === 1 ? new vscode.ThemeIcon(KIND_ICONS[entry.kind ?? 'Other']) : warningIcon();
    this.contextValue = entry.definitions.length > 0 ? 'label hasDefinition' : 'label';
    this.tooltip = new vscode.MarkdownString()
      .appendCodeblock(site.excerpt, 'latex')
      .appendText(`${vscode.workspace.asRelativePath(site.file, false)}:${site.line + 1}`);
    this.command = openCommand(site);
  }
}

class SiteItem extends vscode.TreeItem {
  constructor(site: LabelSite, isDefinition: boolean) {
    super(site.excerpt);
    this.description = `${vscode.workspace.asRelativePath(site.file, false)}:${site.line + 1}`;
    this.iconPath = new vscode.ThemeIcon(isDefinition ? 'tag' : 'references');
    this.tooltip = `${isDefinition ? 'Definition' : 'Reference'} in ${this.description}`;
    this.contextValue = 'site';
    this.command = openCommand(site);
  }
}

type Node = GroupItem | LabelItem | SiteItem;

class LabelsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly entries: () => Promise<LabelEntry[]>) {}

  refresh(): void {
    this.changed.fire();
  }

  async groups(): Promise<GroupItem[]> {
    return groupLabels(await this.entries()).map(
      ({ group, entries }) => new GroupItem(group, entries.map((entry) => new LabelItem(entry, group)))
    );
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      return this.groups();
    }
    if (node instanceof GroupItem) {
      return node.labels;
    }
    if (node instanceof LabelItem) {
      return [
        ...node.entry.definitions.map((site) => new SiteItem(site, true)),
        ...node.entry.references.map((site) => new SiteItem(site, false)),
      ];
    }
    return [];
  }
}

export interface LabelsOptions {
  /** TexLab answers go to definition, find references and rename by itself; these are for when it is not there. */
  useFallbackProviders: () => boolean;
}

export interface Labels {
  groups(): Promise<{ group: string; keys: string[] }[]>;
  /** What the workspace's sources say about a key. */
  entry(key: string): Promise<LabelEntry | undefined>;
}

/** The Labels panel: what the workspace's .tex files define and reference, and renaming across them. */
export function registerLabels(context: vscode.ExtensionContext, options: LabelsOptions): Labels {
  const { useFallbackProviders } = options;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => provider.refresh(), 500);
  };
  const files = new TexFiles<LabelScan>(scanLabels, refreshSoon);
  const entries = async () =>
    mergeLabels((await files.all()).map(({ file, value }) => ({ file: file.fsPath, scan: value })));
  const provider = new LabelsProvider(entries);

  const entryOf = async (arg?: LabelItem | string): Promise<LabelEntry | undefined> => {
    if (arg instanceof LabelItem) {
      return arg.entry;
    }
    return arg ? (await entries()).find((e) => e.key === arg) : undefined;
  };

  /** Throws when `newKey` is not usable, which the rename box shows as its reason. */
  const renameEdit = async (key: string, newKey: string): Promise<vscode.WorkspaceEdit | undefined> => {
    const all = await entries();
    const problem = renameProblem(all, key, newKey);
    if (problem) {
      throw new Error(problem);
    }
    const entry = all.find((e) => e.key === key);
    if (!entry || newKey.trim() === key) {
      return undefined;
    }
    const edit = new vscode.WorkspaceEdit();
    for (const site of [...entry.definitions, ...entry.references]) {
      edit.replace(vscode.Uri.file(site.file), rangeOf(site), newKey.trim());
    }
    return edit;
  };

  const rename = async (arg?: LabelItem | string, given?: string) => {
    const entry = await entryOf(arg);
    if (!entry) {
      return;
    }
    const all = await entries();
    const sites = [...entry.definitions, ...entry.references];
    const fileCount = new Set(sites.map((s) => s.file)).size;
    const newKey =
      given ??
      (await vscode.window.showInputBox({
        title: entry.definitions.length > 0 ? `Rename Label ${entry.key}` : `Replace Undefined Reference ${entry.key}`,
        prompt: `Changes ${sites.length} ${sites.length === 1 ? 'place' : 'places'} in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.`,
        value: entry.key,
        valueSelection: [entry.key.indexOf(':') + 1, entry.key.length],
        validateInput: (value) => renameProblem(all, entry.key, value),
      }));
    if (newKey === undefined) {
      return;
    }
    try {
      // Read again: the files may have changed while the box was open.
      const edit = await renameEdit(entry.key, newKey);
      // As a refactoring, files that were closed are saved instead of left unsaved in the background.
      if (edit && !(await vscode.workspace.applyEdit(edit, { isRefactoring: true }))) {
        void vscode.window.showErrorMessage(`Overtex: could not rename ${entry.key}.`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(`Overtex: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const insertRef = async (arg?: LabelItem | string) => {
    const entry = await entryOf(arg);
    if (!entry) {
      return;
    }
    const text = refCommand(entry);
    // A focused PDF preview leaves no active text editor, while the draft is still on screen.
    const editor = activeTexEditor() ?? vscode.window.visibleTextEditors.find((e) => TEX_LANGUAGES.has(e.document.languageId));
    if (editor) {
      await editor.edit((b) => editor.selections.forEach((selection) => b.replace(selection, text)));
    } else {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(`Overtex: ${text} is on the clipboard.`);
    }
  };

  /** The label or reference under the cursor, with what the project knows about its key. */
  const entryAt = async (doc: vscode.TextDocument, position: vscode.Position) => {
    const found = occurrenceAt(scanLabels(doc.getText()), position.line, position.character);
    return found && (await entries()).find((e) => e.key === found.key);
  };

  const register = vscode.commands.registerCommand;
  context.subscriptions.push(
    { dispose: () => clearTimeout(timer) },
    files,
    vscode.window.createTreeView('overtex.labels', { treeDataProvider: provider, showCollapseAll: true }),
    register('overtex.labels.refresh', () => provider.refresh()),
    register('overtex.labels.rename', rename),
    register('overtex.labels.insertRef', insertRef),
    vscode.languages.registerDefinitionProvider(TEX_SELECTOR, {
      provideDefinition: async (doc, position) => {
        if (!useFallbackProviders()) {
          return undefined;
        }
        return (await entryAt(doc, position))?.definitions.map(locationOf);
      },
    }),
    vscode.languages.registerReferenceProvider(TEX_SELECTOR, {
      provideReferences: async (doc, position, { includeDeclaration }) => {
        if (!useFallbackProviders()) {
          return undefined;
        }
        const entry = await entryAt(doc, position);
        return entry && [...(includeDeclaration ? entry.definitions : []), ...entry.references].map(locationOf);
      },
    }),
    vscode.languages.registerRenameProvider(TEX_SELECTOR, {
      // Throwing here passes the rename on to the next provider, and shows if there is none.
      prepareRename: (doc, position) => {
        const found = useFallbackProviders() ? occurrenceAt(scanLabels(doc.getText()), position.line, position.character) : undefined;
        if (!found) {
          throw new Error('Put the cursor on a label or a reference to rename it.');
        }
        return { range: new vscode.Range(found.line, found.start, found.line, found.end), placeholder: found.key };
      },
      provideRenameEdits: async (doc, position, newName) => {
        if (!useFallbackProviders()) {
          return undefined;
        }
        const found = occurrenceAt(scanLabels(doc.getText()), position.line, position.character);
        return found && renameEdit(found.key, newName);
      },
    })
  );

  return {
    entry: async (key) => (await entries()).find((e) => e.key === key),
    groups: async () =>
      (await provider.groups()).map((g) => ({ group: g.group, keys: g.labels.map((l) => l.entry.key) })),
  };
}
