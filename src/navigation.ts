import { useCallback, useEffect, useState } from 'react';

export type TrainingRoute =
  | { screen: 'home' }
  | { screen: 'statistics' }
  | { screen: 'ticket'; id: number; index?: number }
  | { screen: 'topic'; id: string; question?: string; runId?: number; reviewParent?: number; newQuestions?: boolean };

export function readRoute(search = window.location.search): TrainingRoute {
  const params = new URLSearchParams(search);
  const id = params.get('id');
  if (params.get('screen') === 'statistics') return { screen: 'statistics' };
  const positive = (key: string) => { const value = Number(params.get(key)); return Number.isInteger(value) && value > 0 ? value : undefined; };
  if (params.get('screen') === 'topic' && id) return { screen: 'topic', id, question: params.get('question') || undefined, runId: positive('run'), reviewParent: positive('review'), newQuestions: params.get('new') === '1' };
  if (params.get('screen') === 'ticket' && positive('id')) return { screen: 'ticket', id: positive('id')!, index: positive('question') ? positive('question')! - 1 : undefined };
  return { screen: 'home' };
}

export function routeURL(route: TrainingRoute) {
  const params = new URLSearchParams();
  if (route.screen !== 'home') {
    params.set('screen', route.screen); if ('id' in route) params.set('id', String(route.id));
    if (route.screen === 'ticket' && route.index !== undefined) params.set('question', String(route.index + 1));
    if (route.screen === 'topic') {
      if (route.question) params.set('question', route.question);
      if (route.runId) params.set('run', String(route.runId));
      if (route.reviewParent) params.set('review', String(route.reviewParent));
      if (route.newQuestions) params.set('new', '1');
    }
  }
  return window.location.pathname + (params.size ? `?${params}` : '');
}

export function useTrainingNavigation() {
  const [route, setRoute] = useState<TrainingRoute>(() => readRoute());
  useEffect(() => {
    const restore = () => setRoute(readRoute());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  const navigate = useCallback((next: TrainingRoute, replace = false) => {
    const url = routeURL(next);
    if (url !== window.location.pathname + window.location.search) {
      if (replace) window.history.replaceState(window.history.state, '', url);
      else window.history.pushState(null, '', url);
    }
    setRoute(next);
  }, []);
  return { route, navigate };
}
