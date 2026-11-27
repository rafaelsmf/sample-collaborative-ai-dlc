import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';

const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
  useProjectSprintsCache: () => ({ sprints: [], refresh: () => {} }),
  useProjectsCache: () => ({ invalidate: () => {} }),
}));
vi.mock('@/hooks/useSprintEvents', () => ({ useSprintEvents: () => {} }));
const listAll = vi.fn();
const loaded = (intents: unknown[], truncated: 'cap' | 'error' | null = null) => ({
  intents,
  truncated,
});
const projectMetrics = vi.fn().mockResolvedValue({
  perIntent: [],
  project: { metrics: {}, cost: { totalCost: 0, currency: 'USD', anyUnpriced: false } },
});
vi.mock('@/services/intents', () => ({
  intentsService: {
    listAll: (...a: unknown[]) => listAll(...a),
    projectMetrics: (...a: unknown[]) => projectMetrics(...a),
  },
}));
vi.mock('@/services/projects', () => ({ projectsService: {} }));

import Project, { clearIntentsCacheForTests } from './Project';

function NewIntentStub() {
  return <span data-testid="new-intent-page">NewIntentPage</span>;
}

const V2_PROJECT = {
  id: 'p1',
  name: 'V2 Project',
  kind: 'v2',
  workflowId: 'aidlc-v2',
  gitRepo: 'owner/repo',
  userRole: 'owner',
  trackers: [],
};

const renderProject = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1']}>
      <Routes>
        <Route path="/space/:projectId" element={<Project />} />
        <Route path="/space/:projectId/intent/new" element={<NewIntentStub />} />
      </Routes>
    </MemoryRouter>,
  );

describe('Project page — v2 routing', () => {
  beforeEach(() => {
    useProjectCache.mockReset();
    listAll.mockReset().mockResolvedValue(loaded([]));
    clearIntentsCacheForTests();
  });

  it('renders IntentsView (not the sprint UI) for a v2 project', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    renderProject();
    expect(await screen.findByText('New Intent')).toBeInTheDocument();
    expect(screen.getByText('No intents yet')).toBeInTheDocument();
    expect(screen.queryByText('New Sprint')).not.toBeInTheDocument();
    expect(listAll).toHaveBeenCalledWith('p1', expect.any(Function));
  });

  it('navigates to /space/:projectId/intent/new when New Intent is clicked', async () => {
    useProjectCache.mockReturnValue({
      project: {
        ...V2_PROJECT,
        trackers: [
          {
            id: 'tb-1',
            provider: 'github-issues',
            instance: 'public',
            externalProjectKey: 'owner/repo',
            displayName: 'owner/repo',
            createdAt: null,
            createdBy: null,
          },
        ],
      },
      loading: false,
    });
    renderProject();
    await userEvent.click(await screen.findByText('New Intent'));
    expect(await screen.findByTestId('new-intent-page')).toBeInTheDocument();
  });
});

describe('Project page — Intent list scalability', () => {
  beforeEach(() => {
    useProjectCache.mockReset();
    listAll.mockReset();
    projectMetrics.mockReset().mockResolvedValue({
      perIntent: [],
      project: { metrics: {}, cost: { totalCost: 0, currency: 'USD', anyUnpriced: false } },
    });
    clearIntentsCacheForTests();
  });

  function makeIntents(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `i-${i}`,
      title: `Intent ${i}`,
      status: 'SUCCEEDED',
      currentStage: null,
      createdAt: new Date(2026, 0, count - i).toISOString(),
      updatedAt: new Date(2026, 0, count - i).toISOString(),
    }));
  }

  it('shows at most 10 intents initially and a "Show all" toggle', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(15)));
    renderProject();
    await screen.findByText('Intent 0');
    const rows = screen.getAllByRole('button', { name: /^Intent \d+/ });
    expect(rows.length).toBe(10);
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show all loaded (15)');
  });

  it('does not show a "loaded" count badge next to the Intents heading', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(15)));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.queryByText(/^\d+ loaded$/)).not.toBeInTheDocument();
  });

  it('"Show all" reveals all intents, then "Show recent" hides them', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(12)));
    renderProject();
    await screen.findByText('Intent 0');
    await userEvent.click(screen.getByTestId('intent-show-toggle'));
    expect(screen.getAllByRole('button', { name: /^Intent \d+/ }).length).toBe(12);
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show recent 10');
    await userEvent.click(screen.getByTestId('intent-show-toggle'));
    expect(screen.getAllByRole('button', { name: /^Intent \d+/ }).length).toBe(10);
  });

  it('does not show the toggle when there are 10 or fewer intents', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(8)));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.queryByTestId('intent-show-toggle')).not.toBeInTheDocument();
  });

  it('lists every loaded intent past 100 without a partial notice', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(150)));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show all loaded (150)');
    expect(screen.queryByTestId('intent-list-partial-notice')).not.toBeInTheDocument();
  });

  it('shows the first page while later pages are still loading', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockImplementation((_projectId: string, onPage: (intents: unknown[]) => void) => {
      onPage(makeIntents(50));
      return new Promise(() => {});
    });
    renderProject();
    expect(await screen.findByText('Intent 0')).toBeInTheDocument();
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show all loaded (50)');
  });

  it('keeps the intents read when a later page fails, and says the list is partial', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(50), 'error'));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show all loaded (50)');
    expect(screen.getByTestId('intent-list-partial-notice')).toHaveTextContent(
      'Showing 50 Intents. The full list could not be loaded; refresh to try again.',
    );
  });

  it('says the list stops at the page cap', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValue(loaded(makeIntents(1000), 'cap'));
    renderProject();
    await screen.findByText('Intent 0');
    expect(screen.getByTestId('intent-list-partial-notice')).toHaveTextContent(
      'Showing the first 1000 Intents of this Space.',
    );
  });

  it('does not cache a partial read, so the next visit reloads the list', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValueOnce(loaded(makeIntents(50), 'error'));
    const first = renderProject();
    await screen.findByText('Intent 0');
    first.unmount();

    listAll.mockReturnValueOnce(new Promise(() => {}));
    renderProject();
    await waitFor(() => expect(listAll).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Intent 0')).not.toBeInTheDocument();
  });

  it('keeps a full list on screen while a refresh reads its first page', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockResolvedValueOnce(loaded(makeIntents(150)));
    const first = renderProject();
    await screen.findByText('Intent 0');
    first.unmount();

    listAll.mockImplementationOnce((_projectId: string, onPage?: (i: unknown[]) => void) => {
      onPage?.(makeIntents(50));
      return new Promise(() => {});
    });
    renderProject();
    await waitFor(() => expect(listAll).toHaveBeenCalledTimes(2));
    expect(listAll.mock.calls[1][1]).toBeUndefined();
    expect(screen.getByTestId('intent-show-toggle')).toHaveTextContent('Show all loaded (150)');
  });

  it('ignores an older refresh that finishes after a newer one', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    const pending: ((value: unknown) => void)[] = [];
    listAll.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    function SwitchSpace() {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/space/p2')}>switch space</button>;
    }
    render(
      <MemoryRouter initialEntries={['/space/p1']}>
        <SwitchSpace />
        <Routes>
          <Route path="/space/:projectId" element={<Project />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    await userEvent.click(screen.getByText('switch space'));
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(listAll.mock.calls.map((c) => c[0])).toEqual(['p1', 'p2']);

    const named = (title: string) => [{ ...makeIntents(1)[0], id: title, title }];
    pending[1](loaded(named('Second space intent')));
    expect(await screen.findByText('Second space intent')).toBeInTheDocument();
    pending[0](loaded(named('First space intent')));
    await waitFor(() => expect(screen.getByText('Second space intent')).toBeInTheDocument());
    expect(screen.queryByText('First space intent')).not.toBeInTheDocument();
  });

  it('shows the destination Space list, not the previous one, when switching Spaces', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    const named = (title: string) => [{ ...makeIntents(1)[0], id: title, title }];
    function SwitchSpace() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate('/space/p1')}>to p1</button>
          <button onClick={() => navigate('/space/p2')}>to p2</button>
        </>
      );
    }
    // Both Spaces have a cached full list; the second read of p2 ends partial.
    listAll
      .mockResolvedValueOnce(loaded(named('P2 intent')))
      .mockResolvedValueOnce(loaded(named('P1 intent')))
      .mockResolvedValueOnce(loaded([], 'error'));
    render(
      <MemoryRouter initialEntries={['/space/p2']}>
        <SwitchSpace />
        <Routes>
          <Route path="/space/:projectId" element={<Project />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('P2 intent');
    await userEvent.click(screen.getByText('to p1'));
    await screen.findByText('P1 intent');
    await userEvent.click(screen.getByText('to p2'));
    expect(await screen.findByText('P2 intent')).toBeInTheDocument();
    await waitFor(() => expect(listAll).toHaveBeenCalledTimes(3));
    await screen.findByTestId('intent-list-partial-notice');
    expect(screen.queryByText('P1 intent')).not.toBeInTheDocument();
  });

  it('shows the error when the first page fails', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    listAll.mockRejectedValue(new Error('Request failed (500)'));
    renderProject();
    expect(await screen.findByText('Request failed (500)')).toBeInTheDocument();
    expect(screen.queryByTestId('intent-list-partial-notice')).not.toBeInTheDocument();
  });
});

describe('Project page — Space-scoped usage (coreOnly)', () => {
  beforeEach(() => {
    useProjectCache.mockReset();
    listAll.mockReset().mockResolvedValue(loaded([]));
    clearIntentsCacheForTests();
  });

  it('renders usage without advanced metrics (agent launch, context gauge hidden)', async () => {
    useProjectCache.mockReturnValue({ project: V2_PROJECT, loading: false });
    projectMetrics.mockResolvedValue({
      perIntent: [],
      project: {
        metrics: {
          tokensInput: 10000,
          tokensOutput: 5000,
          contextWindowPct: 60,
          agentLaunchMs: 900,
          artifactsCreated: 5,
        },
        cost: { totalCost: 1.23, currency: 'USD', anyUnpriced: false, anyEstimated: false },
      },
    });
    renderProject();
    await screen.findByText('Input tokens');
    expect(screen.getByText('Output tokens')).toBeInTheDocument();
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.queryByText('Agent launch')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts created')).not.toBeInTheDocument();
    expect(screen.queryByText('Context window')).not.toBeInTheDocument();
    expect(screen.queryByText('Peak context window')).not.toBeInTheDocument();
  });
});
