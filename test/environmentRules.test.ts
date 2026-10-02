import { actionsFor, terminalCheckLine, trustCheckLines, worstLevel } from '../src/environmentRules';

describe('checagens de confiança', () => {
  it('pasta-mãe confiável é erro, com ação para gerenciar a lista', () => {
    const lines = trustCheckLines({
      enabled: true,
      startupPrompt: 'once',
      folders: [{ nome: 'desafio-teste', confiavel: true }],
    });
    const folder = lines.find((l) => l.texto.includes('desafio-teste'));
    expect(folder).toMatchObject({ nivel: 'erro', acao: 'gerenciarConfianca' });
    expect(worstLevel(lines)).toBe('erro');
  });

  it('pasta em modo restrito e pergunta ligada: tudo certo', () => {
    const lines = trustCheckLines({
      enabled: true,
      startupPrompt: 'once',
      folders: [{ nome: 'desafio-teste', confiavel: false }],
    });
    expect(lines.every((l) => l.nivel === 'ok')).toBe(true);
    expect(actionsFor(lines)).toEqual([]);
  });

  it('pergunta desligada (padrão do VS Code atual) é aviso, não erro', () => {
    const lines = trustCheckLines({
      enabled: true,
      startupPrompt: 'never',
      folders: [{ nome: 'x', confiavel: false }],
    });
    expect(lines[0]).toMatchObject({ nivel: 'aviso', acao: 'ligarPerguntaConfianca' });
    expect(worstLevel(lines)).toBe('aviso');
  });

  it('confiança desligada é erro e dispensa as outras checagens', () => {
    const lines = trustCheckLines({ enabled: false, startupPrompt: 'once', folders: [{ nome: 'x', confiavel: true }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ nivel: 'erro', acao: 'ligarConfianca' });
  });

  it('sem pasta aberta, orienta a abrir uma pasta vazia no local dos desafios', () => {
    const lines = trustCheckLines({ enabled: true, startupPrompt: 'once', folders: [] });
    expect(lines.some((l) => l.nivel === 'aviso' && l.texto.includes('pasta vazia'))).toBe(true);
  });
});

describe('checagem do terminal', () => {
  it('cmd.exe é erro e só oferece PowerShell no Windows', () => {
    expect(terminalCheckLine('C:\\WINDOWS\\System32\\cmd.exe', 'win32')).toMatchObject({
      nivel: 'erro',
      acao: 'usarPowerShell',
    });
    expect(terminalCheckLine('cmd.exe', 'linux').acao).toBeUndefined();
  });

  it('PowerShell é ok', () => {
    expect(terminalCheckLine('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32')).toMatchObject({
      nivel: 'ok',
    });
  });
});

describe('botões', () => {
  it('não repetem ações e mantêm a ordem', () => {
    expect(
      actionsFor([
        { nivel: 'erro', texto: 'a', acao: 'guiaInstalacao' },
        { nivel: 'ok', texto: 'b' },
        { nivel: 'erro', texto: 'c', acao: 'gerenciarConfianca' },
        { nivel: 'erro', texto: 'd', acao: 'gerenciarConfianca' },
      ]),
    ).toEqual(['guiaInstalacao', 'gerenciarConfianca']);
  });
});
