import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./menu/menu').then((m) => m.MenuComponent),
  },
  {
    path: 'play',
    loadComponent: () => import('./play/play').then((m) => m.PlayComponent),
  },
  { path: '**', redirectTo: '' },
];
