export interface Manager {
  id: string;
  name: string;
  password: string;
}

export const MANAGERS: Manager[] = [
  { id: 'm001', name: 'Alice', password: 'password123' },
  { id: 'm002', name: 'Bob', password: 'password123' }
];
