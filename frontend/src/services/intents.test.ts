import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import { intentsService } from './intents';

describe('intentsService request paths', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([]);
    post.mockReset().mockResolvedValue({});
    del.mockReset().mockResolvedValue(undefined);
  });

  it('uses intent-scoped attachment routes', async () => {
    await intentsService.attachments('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/attachments');

    const files = [{ filename: 'notes.md', mimeType: 'text/markdown', size: 12 }];
    await intentsService.attachmentUploadUrls('p1', 'i1', files);
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/attachments/upload', {
      attachments: files,
    });

    await intentsService.deleteAttachment('p1', 'i1', 'a/b', 3);
    expect(del).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/attachments/a%2Fb?attachmentRevision=3',
    );
  });

  it('list / list?status', async () => {
    await intentsService.list('p1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents');
    await intentsService.list('p1', 'RUNNING');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents?status=RUNNING');
  });

  it('listPage asks for the paged shape and sends the token back encoded', async () => {
    await intentsService.listPage('p1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents?paged=1');
    await intentsService.listPage('p1', 'a+b/c=');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents?paged=1&nextToken=a%2Bb%2Fc%3D');
  });

  describe('listAll', () => {
    const intent = (id: string, status = 'SUCCEEDED') => ({ id, status });
    const page = (ids: string[], nextToken: string | null, status?: string) => ({
      items: ids.map((id) => intent(id, status)),
      nextToken,
    });

    it('reads every page, reporting each before the next arrives', async () => {
      get
        .mockResolvedValueOnce(page(['a', 'b'], 't1'))
        .mockResolvedValueOnce(page(['c'], 't2'))
        .mockResolvedValueOnce(page([], null));
      const seen: string[][] = [];
      const result = await intentsService.listAll('p1', (partial) =>
        seen.push(partial.map((i) => i.id)),
      );
      expect(result.truncated).toBeNull();
      expect(result.intents.map((i) => i.id)).toEqual(['a', 'b', 'c']);
      expect(seen).toEqual([
        ['a', 'b'],
        ['a', 'b', 'c'],
      ]);
      expect(get.mock.calls.map((c) => c[0])).toEqual([
        '/projects/p1/intents?paged=1',
        '/projects/p1/intents?paged=1&nextToken=t1',
        '/projects/p1/intents?paged=1&nextToken=t2',
      ]);
    });

    it('returns an empty list for a Space without intents', async () => {
      get.mockResolvedValueOnce(page([], null));
      expect(await intentsService.listAll('p1')).toEqual({ intents: [], truncated: null });
    });

    it('keeps one copy of an intent that moved between pages, the later one', async () => {
      get
        .mockResolvedValueOnce(page(['a', 'b'], 't1', 'RUNNING'))
        .mockResolvedValueOnce(page(['b'], null, 'SUCCEEDED'));
      const { intents } = await intentsService.listAll('p1');
      expect(intents).toEqual([intent('a', 'RUNNING'), intent('b', 'SUCCEEDED')]);
    });

    it('keeps what it read when a later page fails', async () => {
      get.mockResolvedValueOnce(page(['a'], 't1')).mockRejectedValueOnce(new Error('timeout'));
      expect(await intentsService.listAll('p1')).toEqual({
        intents: [intent('a')],
        truncated: 'error',
      });
    });

    it('rejects when the first page fails', async () => {
      get.mockRejectedValueOnce(new Error('Not a project member'));
      await expect(intentsService.listAll('p1')).rejects.toThrow('Not a project member');
    });

    it('stops at the page cap', async () => {
      let n = 0;
      get.mockImplementation(async () => page([`i${n++}`], `t${n}`));
      const result = await intentsService.listAll('p1', undefined, 3);
      expect(result.truncated).toBe('cap');
      expect(result.intents).toHaveLength(3);
      expect(get).toHaveBeenCalledTimes(3);
    });
  });

  it('get / create / start / answerGate', async () => {
    await intentsService.get('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1?artifactContent=separate');

    await intentsService.create('p1', { title: 'T', prompt: 'P' });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents', { title: 'T', prompt: 'P' });

    await intentsService.start('p1', 'i1');
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/start', {});

    await intentsService.repair('p1', 'i1');
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/repair', {});

    await intentsService.answerGate('p1', 'i1', 'h1', { answer: { ok: 1 } });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/gates/h1/answer', {
      answer: { ok: 1 },
    });
  });

  it('outputs — lazy transcript with pane + cursor params', async () => {
    await intentsService.outputs('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/outputs');

    await intentsService.outputs('p1', 'i1', { stageInstanceId: 'si-1', afterSeq: 42 });
    expect(get).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/outputs?stageInstanceId=si-1&afterSeq=42',
    );

    // The workspace/init pane key is passed through literally.
    await intentsService.outputs('p1', 'i1', { stageInstanceId: 'intent' });
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/outputs?stageInstanceId=intent');
  });

  it('loads artifact history and encodes artifact and version ids', async () => {
    await intentsService.artifactVersions('p1', 'i1', 'design/head');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/artifacts/design%2Fhead/versions');

    await intentsService.artifactVersion('p1', 'i1', 'design/head', 'design/head:v1');
    expect(get).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/artifacts/design%2Fhead/versions/design%2Fhead%3Av1',
    );
  });
});
