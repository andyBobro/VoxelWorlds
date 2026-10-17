import L from 'leaflet';

// leaflet-draw expects a global `L`; import this module before 'leaflet-draw'.
(window as unknown as { L: typeof L }).L = L;
export { L };
