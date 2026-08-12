export interface Manager {
  id: string;
  name: string;
  password: string;
}

export const MANAGERS: Manager[] = [
  { id: 'mohit', name: 'Mohit', password: 'nava123' },
  { id: 'pranav', name: 'Pranav', password: 'nava123' },
  { id: 'navaneeth', name: 'Navaneeth', password: 'nava123' }
];
