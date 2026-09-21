const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const store = require('./store');

const SHADCN_UI_SHIM = `
const React = window.React;
const { useState, useEffect, useRef, useContext, createContext } = React;

function Card({ className = '', ...props }) {
  return React.createElement('div', { className: 'rounded-xl border border-slate-200/80 bg-white text-slate-900 shadow-sm ' + className, ...props });
}
function CardHeader({ className = '', ...props }) {
  return React.createElement('div', { className: 'flex flex-col space-y-1.5 p-6 ' + className, ...props });
}
function CardTitle({ className = '', ...props }) {
  return React.createElement('h3', { className: 'font-semibold tracking-tight text-slate-900 ' + className, ...props });
}
function CardDescription({ className = '', ...props }) {
  return React.createElement('p', { className: 'text-sm text-slate-500 ' + className, ...props });
}
function CardContent({ className = '', ...props }) {
  return React.createElement('div', { className: 'p-6 pt-0 ' + className, ...props });
}
function CardFooter({ className = '', ...props }) {
  return React.createElement('div', { className: 'flex items-center p-6 pt-0 ' + className, ...props });
}

function Button({ className = '', variant = 'default', size = 'default', children, ...props }) {
  let base = 'inline-flex items-center justify-center rounded-lg text-sm font-medium transition-all cursor-pointer select-none active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none ';
  if (variant === 'ghost') base += 'hover:bg-slate-100 text-slate-700 ';
  else if (variant === 'destructive') base += 'bg-rose-600 text-white hover:bg-rose-700 shadow-sm ';
  else if (variant === 'outline') base += 'border border-slate-200 bg-white text-slate-800 hover:bg-slate-50 ';
  else if (variant === 'secondary') base += 'bg-slate-100 text-slate-800 hover:bg-slate-200 ';
  else base += 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm ';
  
  if (size === 'icon') base += 'h-9 w-9 p-0 ';
  else if (size === 'sm') base += 'h-8 px-3 text-xs ';
  else if (size === 'lg') base += 'h-11 px-8 ';
  else base += 'h-9 px-4 py-2 ';

  return React.createElement('button', { className: base + className, ...props }, children);
}

function Input({ className = '', type = 'text', ...props }) {
  return React.createElement('input', {
    type,
    className: 'flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 ' + className,
    ...props
  });
}

function Label({ className = '', ...props }) {
  return React.createElement('label', { className: 'text-sm font-medium text-slate-700 leading-none ' + className, ...props });
}

function Textarea({ className = '', ...props }) {
  return React.createElement('textarea', {
    className: 'flex min-h-[60px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 ' + className,
    ...props
  });
}

function Badge({ className = '', variant = 'default', children, ...props }) {
  let base = 'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ';
  if (variant === 'secondary') base += 'border-transparent bg-slate-100 text-slate-900 ';
  else if (variant === 'destructive') base += 'border-transparent bg-rose-500 text-white ';
  else if (variant === 'outline') base += 'border-slate-200 text-slate-800 ';
  else base += 'border-transparent bg-emerald-600 text-white ';
  return React.createElement('span', { className: base + className, ...props }, children);
}

function Progress({ value = 0, className = '', ...props }) {
  return React.createElement('div', { className: 'relative h-2 w-full overflow-hidden rounded-full bg-slate-100 ' + className, ...props },
    React.createElement('div', { className: 'h-full bg-emerald-600 transition-all duration-300', style: { width: \`\${Math.min(100, Math.max(0, value))}%\` } })
  );
}

const DialogContext = React.createContext({ isOpen: false, setOpen: () => {} });

function Dialog({ open: controlledOpen, onOpenChange, children }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen;
  const setOpen = onOpenChange || setUncontrolledOpen;
  return React.createElement(DialogContext.Provider, { value: { isOpen, setOpen } }, children);
}

function DialogTrigger({ asChild, children, ...props }) {
  const { setOpen } = React.useContext(DialogContext);
  const handleClick = (e) => {
    if (children && children.props && children.props.onClick) children.props.onClick(e);
    setOpen(true);
  };
  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children, { ...props, onClick: handleClick });
  }
  return React.createElement('button', { ...props, onClick: handleClick }, children);
}

function DialogContent({ className = '', children, ...props }) {
  const { isOpen, setOpen } = React.useContext(DialogContext);
  if (!isOpen) return null;
  return React.createElement('div', {
    className: 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm',
    onClick: (e) => { if (e.target === e.currentTarget) setOpen(false); }
  },
    React.createElement('div', {
      className: 'relative w-full max-w-lg bg-white rounded-2xl p-6 shadow-2xl border border-slate-100 ' + className,
      ...props
    },
      React.createElement('button', {
        className: 'absolute top-4 right-4 opacity-70 hover:opacity-100 text-slate-500 text-lg cursor-pointer',
        onClick: () => setOpen(false)
      }, '✕'),
      children
    )
  );
}

function DialogHeader({ className = '', ...props }) {
  return React.createElement('div', { className: 'flex flex-col space-y-1.5 text-center sm:text-left mb-4 ' + className, ...props });
}
function DialogTitle({ className = '', ...props }) {
  return React.createElement('h2', { className: 'text-lg font-semibold leading-none tracking-tight text-slate-900 ' + className, ...props });
}
function DialogDescription({ className = '', ...props }) {
  return React.createElement('p', { className: 'text-sm text-slate-500 ' + className, ...props });
}
function DialogFooter({ className = '', ...props }) {
  return React.createElement('div', { className: 'flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2 mt-6 ' + className, ...props });
}

function Select({ value, onValueChange, defaultValue, children }) {
  const [val, setVal] = useState(value !== undefined ? value : defaultValue);
  useEffect(() => { if (value !== undefined) setVal(value); }, [value]);
  const handleChange = (newVal) => { setVal(newVal); if (onValueChange) onValueChange(newVal); };
  const items = [];
  function extractItems(nodes) {
    React.Children.forEach(nodes, child => {
      if (!child) return;
      if (child.type && (child.type.name === 'SelectItem' || child.props?.value)) {
        items.push({ value: child.props.value, label: child.props.children });
      } else if (child.props && child.props.children) {
        extractItems(child.props.children);
      }
    });
  }
  extractItems(children);
  return React.createElement('select', {
    value: val,
    onChange: e => handleChange(e.target.value),
    className: 'flex h-9 w-full rounded-md border border-slate-200 bg-white px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500 cursor-pointer'
  }, items.map(item => React.createElement('option', { key: item.value, value: item.value }, item.label)));
}

function SelectTrigger({ children }) { return children; }
function SelectValue({ placeholder }) { return null; }
function SelectContent({ children }) { return children; }
function SelectItem({ value, children }) { return React.createElement('option', { value }, children); }

function Tabs({ defaultValue, value, onValueChange, children, className = '' }) {
  const [selected, setSelected] = useState(value || defaultValue);
  return React.createElement('div', { className }, children);
}
function TabsList({ children, className = '' }) {
  return React.createElement('div', { className: 'inline-flex h-9 items-center justify-center rounded-lg bg-slate-100 p-1 text-slate-500 ' + className }, children);
}
function TabsTrigger({ value, children, className = '' }) {
  return React.createElement('button', { className: 'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all ' + className }, children);
}
function TabsContent({ value, children, className = '' }) {
  return React.createElement('div', { className: 'mt-2 ' + className }, children);
}

// --- Controls that need real behaviour ------------------------------------
// The catch-all stub below renders an unknown component as a plain <div>. That
// is harmless for a layout wrapper but silently broken for anything the user
// has to interact with: a stubbed RadioGroup renders as nested divs, so nothing
// is clickable and no value is ever selected. These have to be real inputs.

const RadioGroupContext = React.createContext({ value: undefined, select: () => {} });

function RadioGroup({ value, onValueChange, defaultValue, children, className = '', ...props }) {
  const [val, setVal] = useState(value !== undefined ? value : defaultValue);
  useEffect(() => { if (value !== undefined) setVal(value); }, [value]);
  const select = (next) => { setVal(next); if (onValueChange) onValueChange(next); };
  return React.createElement(RadioGroupContext.Provider, { value: { value: val, select } },
    React.createElement('div', { role: 'radiogroup', className, ...props }, children));
}

function RadioGroupItem({ value, id, className = '', ...props }) {
  const ctx = useContext(RadioGroupContext);
  return React.createElement('input', {
    type: 'radio',
    id,
    value,
    checked: ctx.value === value,
    onChange: () => ctx.select(value),
    className: 'h-4 w-4 accent-emerald-600 cursor-pointer ' + className,
    ...props
  });
}

function Checkbox({ checked: controlled, onCheckedChange, defaultChecked, className = '', ...props }) {
  const [on, setOn] = useState(controlled !== undefined ? controlled : !!defaultChecked);
  useEffect(() => { if (controlled !== undefined) setOn(controlled); }, [controlled]);
  return React.createElement('input', {
    type: 'checkbox',
    checked: on,
    onChange: (e) => {
      const next = e.target.checked;
      if (controlled === undefined) setOn(next);
      if (onCheckedChange) onCheckedChange(next);
    },
    className: 'h-4 w-4 rounded accent-emerald-600 cursor-pointer ' + className,
    ...props
  });
}

function Switch({ checked: controlled, onCheckedChange, defaultChecked, className = '', ...props }) {
  const [on, setOn] = useState(controlled !== undefined ? controlled : !!defaultChecked);
  useEffect(() => { if (controlled !== undefined) setOn(controlled); }, [controlled]);
  const toggle = () => {
    const next = !on;
    if (controlled === undefined) setOn(next);
    if (onCheckedChange) onCheckedChange(next);
  };
  return React.createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': on,
    onClick: toggle,
    className: 'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors cursor-pointer ' +
      (on ? 'bg-emerald-600 ' : 'bg-slate-300 ') + className,
    ...props
  }, React.createElement('span', {
    className: 'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ' +
      (on ? 'translate-x-4' : 'translate-x-0.5')
  }));
}

function Slider({ value, onValueChange, defaultValue, min = 0, max = 100, step = 1, className = '', ...props }) {
  const controlled = value !== undefined;
  const current = controlled ? (Array.isArray(value) ? value[0] : value)
                             : (Array.isArray(defaultValue) ? defaultValue[0] : defaultValue);
  return React.createElement('input', {
    type: 'range',
    min, max, step,
    value: controlled ? current : undefined,
    defaultValue: controlled ? undefined : current,
    onChange: (e) => {
      if (onValueChange) {
        const n = Number(e.target.value);
        onValueChange(Array.isArray(value) ? [n] : n);
      }
    },
    className: 'w-full accent-emerald-600 cursor-pointer ' + className,
    ...props
  });
}

function Separator({ orientation = 'horizontal', className = '', ...props }) {
  return React.createElement('div', {
    role: 'separator',
    className: (orientation === 'vertical' ? 'w-px self-stretch bg-slate-200 ' : 'h-px w-full bg-slate-200 ') + className,
    ...props
  });
}

function Skeleton({ className = '', ...props }) {
  return React.createElement('div', { className: 'animate-pulse rounded-md bg-slate-200 ' + className, ...props });
}

function Alert({ variant = 'default', className = '', ...props }) {
  const base = 'relative w-full rounded-lg border p-4 text-sm ';
  const tone = variant === 'destructive'
    ? 'border-rose-200 bg-rose-50 text-rose-800 '
    : 'border-slate-200 bg-slate-50 text-slate-800 ';
  return React.createElement('div', { role: 'alert', className: base + tone + className, ...props });
}
function AlertTitle({ className = '', ...props }) {
  return React.createElement('h5', { className: 'mb-1 font-semibold leading-none tracking-tight ' + className, ...props });
}
function AlertDescription({ className = '', ...props }) {
  return React.createElement('div', { className: 'text-sm opacity-90 ' + className, ...props });
}

// Real table markup: a <div> stub collapses the column layout entirely.
function Table({ className = '', ...props }) {
  return React.createElement('div', { className: 'relative w-full overflow-auto' },
    React.createElement('table', { className: 'w-full caption-bottom text-sm ' + className, ...props }));
}
function TableHeader({ className = '', ...props }) {
  return React.createElement('thead', { className: 'border-b border-slate-200 ' + className, ...props });
}
function TableBody({ className = '', ...props }) {
  return React.createElement('tbody', { className, ...props });
}
function TableFooter({ className = '', ...props }) {
  return React.createElement('tfoot', { className: 'border-t border-slate-200 bg-slate-50 font-medium ' + className, ...props });
}
function TableRow({ className = '', ...props }) {
  return React.createElement('tr', { className: 'border-b border-slate-100 transition-colors hover:bg-slate-50 ' + className, ...props });
}
function TableHead({ className = '', ...props }) {
  return React.createElement('th', { className: 'h-10 px-3 text-left align-middle font-medium text-slate-500 ' + className, ...props });
}
function TableCell({ className = '', ...props }) {
  return React.createElement('td', { className: 'p-3 align-middle ' + className, ...props });
}
function TableCaption({ className = '', ...props }) {
  return React.createElement('caption', { className: 'mt-4 text-sm text-slate-500 ' + className, ...props });
}

// Proxy catch-all: any named import not in the map returns a no-op stub
const _shadcnDefined = {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
  Button, Input, Label, Textarea, Badge, Progress,
  Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
  Tabs, TabsList, TabsTrigger, TabsContent,
  RadioGroup, RadioGroupItem, Checkbox, Switch, Slider, Separator, Skeleton,
  Alert, AlertTitle, AlertDescription,
  Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption
};

const shadcnProxy = new Proxy(_shadcnDefined, {
  get(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string' || prop === '__esModule' || prop === 'default') return undefined;
    function ShadcnStub({ children, className = '', ...props }) {
      return React.createElement('div', { className, ...props }, children);
    }
    ShadcnStub.displayName = prop;
    return ShadcnStub;
  },
  has() { return true; },
  ownKeys(target) { return Object.keys(target); },
  getOwnPropertyDescriptor(target, prop) {
    const val = target[prop];
    if (!val) return undefined;
    return { enumerable: true, configurable: true, value: val };
  }
});

module.exports = shadcnProxy;
`;

const LUCIDE_ICONS_SHIM = `
const _React = window.React;

const _SVG_PATHS = {
  Wallet: 'M21 12V7H5a2 2 0 0 1 0-4h14v4M3 5v14a2 2 0 0 0 2 2h16v-5M18 12a2 2 0 0 0 0 4h4v-4Z',
  TrendingUp: 'm22 7-8.5 8.5-5-5L2 17M16 7h6v6',
  TrendingDown: 'm22 17-8.5-8.5-5 5L2 7M16 17h6v-6',
  Receipt: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1ZM8 7h8M8 11h8M8 15h5',
  CalendarDays: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01',
  Plus: 'M12 5v14M5 12h14',
  Trash2: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6',
  X: 'M18 6 6 18M6 6l12 12',
  Check: 'M20 6 9 17l-5-5',
  ArrowRight: 'M5 12h14M12 5l7 7-7 7',
  ArrowLeft: 'M19 12H5M12 19l-7-7 7-7',
  Search: 'm21 21-4.35-4.35M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  Filter: 'M22 3H2l8 9.46V19l4 2v-8.54L22 3Z',
  DollarSign: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  CreditCard: 'M2 5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2ZM2 10h20',
  PieChart: 'M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z',
  BarChart: 'M12 20V10M18 20V4M6 20v-4',
  Settings: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  User: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  Mail: 'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6',
  Phone: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.36 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.27 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z',
  Lock: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  Bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
  AlertCircle: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 8v4M12 16h.01',
  ChevronDown: 'M6 9l6 6 6-6',
  ChevronUp: 'M18 15l-6-6-6 6',
  ChevronLeft: 'M15 18l-6-6 6-6',
  ChevronRight: 'M9 18l6-6-6-6',
  Menu: 'M3 12h18M3 6h18M3 18h18',
  Home: 'M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM9 22V12h6v10',
  Download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  Upload: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12',
  Edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  Eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  LogOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  RefreshCw: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  Copy: 'M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
  Zap: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  Star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
  Info: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 16v-4M12 8h.01',
  CheckCircle: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
  AlertTriangle: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
  Clock: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 6v6l4 2',
  Calendar: 'M3 4h18v18H3V4zM8 2v4M16 2v4M3 10h18',
  Activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  Globe: 'M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zM2 12h20',
  Send: 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z',
  Code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
  FileText: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  List: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  MoreHorizontal: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  MoreVertical: 'M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  ExternalLink: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
  Tag: 'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82zM7 7h.01',
  MessageSquare: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  Award: 'M12 15c3.31 0 6-2.69 6-6s-2.69-6-6-6-6 2.69-6 6 2.69 6 6 6zM8.21 13.89L7 23l5-3 5 3-1.21-9.12',
  Target: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  Layers: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  Shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

function _makeIcon(name, d) {
  function LucideIcon(props) {
    var className = props.className !== undefined ? props.className : 'w-4 h-4 inline-block';
    var size = props.size !== undefined ? props.size : 18;
    var color = props.color !== undefined ? props.color : 'currentColor';
    var strokeWidth = props.strokeWidth !== undefined ? props.strokeWidth : 2;
    var rest = {};
    for (var k in props) {
      if (k !== 'className' && k !== 'size' && k !== 'color' && k !== 'strokeWidth') {
        rest[k] = props[k];
      }
    }
    return _React.createElement('svg', Object.assign({
      xmlns: 'http://www.w3.org/2000/svg',
      width: size, height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: color,
      strokeWidth: strokeWidth,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: className
    }, rest), _React.createElement('path', { d: d }));
  }
  LucideIcon.displayName = name;
  return LucideIcon;
}

// Build the known icon map
var _icons = {};
var _keys = Object.keys(_SVG_PATHS);
for (var _i = 0; _i < _keys.length; _i++) {
  _icons[_keys[_i]] = _makeIcon(_keys[_i], _SVG_PATHS[_keys[_i]]);
}

// Proxy: any icon name not in _SVG_PATHS gets a generic square-dot fallback
var _fallbackPath = 'M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0';
var lucideProxy = new Proxy(_icons, {
  get: function(target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string' || prop === '__esModule') return undefined;
    return _makeIcon(prop, _fallbackPath);
  },
  has: function() { return true; },
  ownKeys: function(target) { return Object.keys(target); },
  getOwnPropertyDescriptor: function(target, prop) {
    var val = target[prop] || _makeIcon(prop, _fallbackPath);
    return { enumerable: true, configurable: true, value: val };
  }
});

module.exports = lucideProxy;
`;


const RECHARTS_SHIM = `
const React = window.React;

const RECHARTS_KEYS = [
  'ResponsiveContainer', 'LineChart', 'Line', 'XAxis', 'YAxis', 'ZAxis',
  'CartesianGrid', 'Tooltip', 'PieChart', 'Pie', 'Cell', 'Legend',
  'BarChart', 'Bar', 'AreaChart', 'Area', 'ScatterChart', 'Scatter',
  'RadarChart', 'Radar', 'PolarGrid', 'PolarAngleAxis', 'PolarRadiusAxis'
];

function makeChartStub(name) {
  return function RechartsStub({ children, className = '', ...props }) {
    if (name === 'ResponsiveContainer') {
      return React.createElement('div', { className: 'w-full min-h-[260px] ' + className }, children);
    }
    if (name.includes('Chart')) {
      return React.createElement('div', { className: 'relative w-full h-full flex flex-col items-center justify-center ' + className }, children);
    }
    if (children) return React.createElement(React.Fragment, null, children);
    return null;
  };
}

const rechartsProxy = new Proxy({ __esModule: true }, {
  get(target, prop) {
    if (prop === '__esModule') return true;
    if (typeof prop !== 'string' || prop === 'default') return undefined;
    if (window.Recharts && window.Recharts[prop]) return window.Recharts[prop];
    return makeChartStub(prop);
  },
  has() { return true; },
  ownKeys() {
    const real = window.Recharts ? Object.keys(window.Recharts) : [];
    return Array.from(new Set(['__esModule', ...RECHARTS_KEYS, ...real]));
  },
  getOwnPropertyDescriptor(target, prop) {
    const val = (window.Recharts && window.Recharts[prop]) ? window.Recharts[prop] : makeChartStub(prop);
    return { enumerable: true, configurable: true, value: val };
  }
});

module.exports = rechartsProxy;
`;

// clsx / tailwind-merge / class-variance-authority / the shadcn "@/lib/utils"
// helper. Each of these is a tiny class-name joiner, and a generated component
// imports at least one of them nine times out of ten. A null-returning stub
// would silently strip every className, so the real joining logic lives here.
//
// The module is exported as a *callable* proxy: `import clsx from 'clsx'` calls
// it directly, while `import { cn } from '@/lib/utils'` reads a property off it.
const CN_SHIM = `
function cn() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    if (!a) continue;
    if (typeof a === 'string' || typeof a === 'number') out.push(a);
    else if (Array.isArray(a)) out.push(cn.apply(null, a));
    else if (typeof a === 'object') { for (var k in a) { if (a[k]) out.push(k); } }
  }
  return out.join(' ');
}

function cva(base, config) {
  return function (props) {
    props = props || {};
    var out = [base];
    var variants = (config && config.variants) || {};
    var defaults = (config && config.defaultVariants) || {};
    for (var key in variants) {
      var choice = props[key] !== undefined ? props[key] : defaults[key];
      var cls = variants[key] && variants[key][choice];
      if (cls) out.push(cls);
    }
    if (props.class) out.push(props.class);
    if (props.className) out.push(props.className);
    return cn.apply(null, out);
  };
}

var _api = {
  cn: cn,
  clsx: cn,
  cx: cn,
  twMerge: function () { return cn.apply(null, arguments); },
  cva: cva,
  // Models sometimes write "import { fetch } from '@/lib/utils'" or
  // "import { cn } from '@/lib/utils'" interchangeably. fetch must be the
  // real global fetch, not the cn joiner, or a generated app silently
  // replaces window.fetch and dies on its first network call.
  fetch: function () { return window.fetch.apply(window, arguments); },
  default: cn
};

module.exports = new Proxy(cn, {
  get: function (target, prop) {
    if (prop === '__esModule') return true;
    if (prop === 'default') return cn;
    if (prop in _api) return _api[prop];
    if (typeof prop !== 'string') return undefined;
    return cn;
  },
  apply: function (target, thisArg, args) { return cn.apply(null, args); },
  has: function () { return true; },
  ownKeys: function () { return Object.keys(_api); },
  getOwnPropertyDescriptor: function (target, prop) {
    return { enumerable: true, configurable: true, value: (prop in _api) ? _api[prop] : cn };
  }
});
`;

// date-fns. Generated dashboards reach for it constantly and there is no copy
// in this sandbox, which used to fail the whole preview build.
const DATE_FNS_SHIM = `
function _d(v) { return v instanceof Date ? v : new Date(v); }
function _startOfDay(d) { var x = _d(d); return new Date(x.getFullYear(), x.getMonth(), x.getDate()); }
function _addDays(d, n) { var x = _startOfDay(d); x.setDate(x.getDate() + n); return x; }
function _startOfWeek(d, opts) {
  var x = _startOfDay(d);
  var wk = (opts && opts.weekStartsOn) || 0;
  x.setDate(x.getDate() - ((x.getDay() - wk + 7) % 7));
  return x;
}

function parseISO(s) {
  if (s instanceof Date) return s;
  var str = String(s);
  return new Date(str.length === 10 ? str + 'T00:00:00' : str);
}

function format(date, pattern) {
  var d = date instanceof Date ? date : parseISO(date);
  if (isNaN(d.getTime())) return '';
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  var map = {
    yyyy: d.getFullYear(), yy: String(d.getFullYear()).slice(-2),
    MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1), M: d.getMonth() + 1,
    dd: pad(d.getDate()), d: d.getDate(),
    EEEE: DAYS[d.getDay()], EEE: DAYS[d.getDay()].slice(0, 3),
    HH: pad(d.getHours()), H: d.getHours(),
    hh: pad(d.getHours() % 12 || 12), h: d.getHours() % 12 || 12,
    mm: pad(d.getMinutes()), m: d.getMinutes(),
    ss: pad(d.getSeconds()), s: d.getSeconds(),
    a: d.getHours() < 12 ? 'AM' : 'PM'
  };
  // Longest-first so 'MM' is not eaten by 'M'.
  return String(pattern).replace(
    /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|H|hh|h|mm|m|ss|s|a/g,
    function (t) { return String(map[t]); }
  );
}

function isSameDay(a, b) { return _startOfDay(a).getTime() === _startOfDay(b).getTime(); }
function isToday(date) { return isSameDay(date, new Date()); }
function isThisWeek(date, opts) { return _startOfWeek(date, opts).getTime() === _startOfWeek(new Date(), opts).getTime(); }
function isThisMonth(date) {
  var a = _d(date), b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}
function isSameMonth(a, b) { var x = _d(a), y = _d(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth(); }
function isSameYear(a, b) { return _d(a).getFullYear() === _d(b).getFullYear(); }
function startOfMonth(d) { var x = _d(d); return new Date(x.getFullYear(), x.getMonth(), 1); }
function endOfMonth(d) { var x = _d(d); return new Date(x.getFullYear(), x.getMonth() + 1, 0, 23, 59, 59, 999); }
function startOfDay(d) { return _startOfDay(d); }
function endOfDay(d) { var x = _d(d); return new Date(x.getFullYear(), x.getMonth(), x.getDate(), 23, 59, 59, 999); }
function startOfWeek(d, o) { return _startOfWeek(d, o); }
function endOfWeek(d, o) { return _addDays(_startOfWeek(d, o), 6); }
function startOfYear(d) { return new Date(_d(d).getFullYear(), 0, 1); }
function subDays(d, n) { return _addDays(d, -n); }
function addDays(d, n) { return _addDays(d, n); }
function subMonths(d, n) { var x = _d(d); return new Date(x.getFullYear(), x.getMonth() - n, x.getDate()); }
function addMonths(d, n) { return subMonths(d, -n); }
function differenceInDays(a, b) { return Math.round((_startOfDay(a) - _startOfDay(b)) / 86400000); }
function isValid(d) { return !isNaN(_d(d).getTime()); }
function formatDistanceToNow(date) {
  var mins = Math.round((Date.now() - _d(date).getTime()) / 60000);
  if (mins < 1) return 'less than a minute';
  if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's');
  var hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + ' hour' + (hrs === 1 ? '' : 's');
  var days = Math.round(hrs / 24);
  return days + ' day' + (days === 1 ? '' : 's');
}
function eachDayOfInterval(range) {
  var out = [];
  var cur = _startOfDay(range.start);
  var last = _startOfDay(range.end);
  var guard = 0;
  while (cur <= last && guard++ < 1000) { out.push(cur); cur = _addDays(cur, 1); }
  return out;
}
function eachMonthOfInterval(range) {
  var out = [];
  var cur = startOfMonth(range.start);
  var last = startOfMonth(range.end);
  var guard = 0;
  while (cur <= last && guard++ < 240) {
    out.push(cur);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return out;
}

var _dateFns = {
  format: format, parseISO: parseISO, isValid: isValid,
  isToday: isToday, isThisWeek: isThisWeek, isThisMonth: isThisMonth,
  isSameDay: isSameDay, isSameMonth: isSameMonth, isSameYear: isSameYear,
  startOfDay: startOfDay, endOfDay: endOfDay,
  startOfWeek: startOfWeek, endOfWeek: endOfWeek,
  startOfMonth: startOfMonth, endOfMonth: endOfMonth, startOfYear: startOfYear,
  addDays: addDays, subDays: subDays, addMonths: addMonths, subMonths: subMonths,
  differenceInDays: differenceInDays, differenceInCalendarDays: differenceInDays,
  eachDayOfInterval: eachDayOfInterval, eachMonthOfInterval: eachMonthOfInterval,
  formatDistanceToNow: formatDistanceToNow
};

module.exports = new Proxy(_dateFns, {
  get: function (target, prop) {
    if (prop in target) return target[prop];
    if (typeof prop !== 'string' || prop === '__esModule' || prop === 'default') return undefined;
    return function dateFnsStub() { return null; };
  },
  has: function () { return true; },
  ownKeys: function (target) { return Object.keys(target); },
  getOwnPropertyDescriptor: function (target, prop) {
    return { enumerable: true, configurable: true, value: target[prop] || function () { return null; } };
  }
});
`;

// Last resort for an npm package this sandbox has no copy of: resolve it to a
// stub instead of failing the entire build. The component renders without that
// library's behaviour, but the user still gets a preview to look at.
const VENDOR_SHIM = `
var vendorProxy = new Proxy({}, {
  get: function (target, prop) {
    if (typeof prop !== 'string' || prop === 'default' || prop === '__esModule') return undefined;
    if (!(prop in target)) {
      var fn = function () { return null; };
      fn.displayName = prop;
      target[prop] = fn;
    }
    return target[prop];
  },
  has: function () { return true; },
  ownKeys: function (target) { return Object.keys(target); },
  getOwnPropertyDescriptor: function (target, prop) {
    return { enumerable: true, configurable: true, value: target[prop] || function () { return null; } };
  }
});

module.exports = vendorProxy;
`;

const CN_PACKAGES = ['clsx', 'tailwind-merge', 'class-variance-authority'];

// The automatic JSX runtime. Without it in the resolver, `react/jsx-runtime` fell
// through to the vendor catch-all, whose `jsx()` returns null — a React-free
// App.tsx (which is what modern tooling emits) rendered a blank white page with
// no build error and no runtime error to explain it.
const JSX_RUNTIME_SHIM = `
var React = window.React;
function makeElement(type, props, key) {
  var out = {};
  for (var k in (props || {})) {
    if (k === 'key' || k === '__self' || k === '__source') continue;
    out[k] = props[k];
  }
  if (key !== undefined) out.key = key;
  return React.createElement(type, out);
}
module.exports = {
  Fragment: React.Fragment,
  jsx: makeElement,
  jsxs: makeElement,
  jsxDEV: makeElement
};
`;

// ---------------------------------------------------------------------------
// Project discovery & import resolution
//
// Shared by the Live Preview (buildReactApp) and by diagnostics.js. It must stay
// shared: if the two ever resolved imports differently, diagnostics would report
// a clean build for a preview that fails to compile — and the whole point of
// diagnostics is to tell a repair pass the truth about what is broken.
// ---------------------------------------------------------------------------

/** Recursively lists every file under `root`, as forward-slashed relative paths. */
function scanFiles(root) {
  const files = [];
  (function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isFile()) files.push(r);
    }
  })(root, '');
  return files;
}

const ENTRY_CANDIDATES = [
  'src/App.tsx', 'src/App.jsx', 'src/App.js', 'src/App.ts',
  'src/main.tsx', 'src/main.jsx', 'src/index.tsx', 'src/index.jsx',
  'App.tsx', 'App.jsx', 'App.js', 'App.ts'
];

/** Finds the file the app is mounted from, or null if this isn't a React project. */
function findEntry(chatDir, files = scanFiles(chatDir)) {
  return ENTRY_CANDIDATES.find(c => files.includes(c))
    || files.find(f => /\bApp\.(tsx|jsx)$/i.test(f))
    || files.find(f => /\.(tsx|jsx)$/i.test(f))
    || null;
}

/**
 * Builds the esbuild plugin that resolves a generated project's imports against
 * the sandbox's virtual shims.
 *
 * @param {object}   opts
 * @param {string}   opts.srcDir     directory `@/` maps onto
 * @param {Function} [opts.onShimmed] (name, kind) => void, called for every import
 *   that only resolves because a shim caught it. `kind` is one of
 *   'shadcn' | 'helper' | 'vendor' | 'lucide' | 'recharts'. Diagnostics uses this
 *   to warn that a library's behaviour will be approximate.
 */
function makeSandboxPlugin({ srcDir, projectDir = null, onShimmed = null } = {}) {
  const note = (name, kind) => { try { onShimmed?.(name, kind); } catch { /* never fatal */ } };
  const rootDir = path.resolve(srcDir);
  // The generated project's own directory. `@/` and relative imports must not
  // reach outside it: a specifier like `@/../../../../Users/…/secret` used to
  // resolve, and esbuild bundled that file's contents into the page.
  const projectRoot = path.resolve(projectDir || rootDir);
  const LOCAL_EXTS = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.js'];

  const isInside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

  const firstExisting = (candidate) => {
    for (const ext of LOCAL_EXTS) {
      const full = candidate + ext;
      try {
        if (fs.existsSync(full) && !fs.statSync(full).isDirectory()) return path.resolve(full);
      } catch { /* unreadable — treat as missing */ }
    }
    return null;
  };

  /** Resolves a `@/…` specifier to a real file inside the project, or null. */
  const resolveAlias = (spec) => {
    const candidate = path.resolve(rootDir, spec.slice(2));
    if (!isInside(rootDir, candidate)) return null;
    return firstExisting(candidate);
  };

  return {
    name: 'hama-sandbox-plugin',
    setup(build) {
      // 1. React / ReactDOM come from the page's own <script> tags, including
      //    the automatic JSX runtime the JSX transform emits imports for.
      build.onResolve({ filter: /^(react|react-dom|react-dom\/client|react\/jsx-runtime|react\/jsx-dev-runtime)$/ }, args => ({
        path: args.path, namespace: 'global-ns'
      }));
      build.onLoad({ filter: /.*/, namespace: 'global-ns' }, args => {
        if (args.path === 'react') return { contents: 'module.exports = window.React;', loader: 'js' };
        if (args.path.startsWith('react-dom')) return { contents: 'module.exports = window.ReactDOM;', loader: 'js' };
        if (args.path.startsWith('react/jsx')) return { contents: JSX_RUNTIME_SHIM, loader: 'js' };
      });

      // 2. Recharts — the real library, loaded from a CDN into window.Recharts.
      build.onResolve({ filter: /^recharts$/ }, () => ({
        path: 'recharts', namespace: 'recharts-ns'
      }));
      build.onLoad({ filter: /.*/, namespace: 'recharts-ns' }, () => ({
        contents: RECHARTS_SHIM, loader: 'js'
      }));

      // 3. lucide-react — generated SVG icons with a fallback glyph.
      build.onResolve({ filter: /^lucide-react$/ }, () => ({
        path: 'lucide-react', namespace: 'lucide-ns'
      }));
      build.onLoad({ filter: /.*/, namespace: 'lucide-ns' }, () => ({
        contents: LUCIDE_ICONS_SHIM, loader: 'js'
      }));

      // 4. shadcn/ui components — but ONLY when the project does not ship its own.
      //    esbuild takes the first non-null onResolve result, so this rule ran
      //    before the local-file rule below for every `@/components/ui/*` import
      //    and quietly replaced a real, model-written component with the generic
      //    stub (which renders a plain <div>).
      build.onResolve({ filter: /^@\/components\/ui\// }, args => {
        const local = resolveAlias(args.path);
        if (local) return { path: local };
        note(args.path.slice('@/components/ui/'.length), 'shadcn');
        return { path: args.path, namespace: 'shadcn-ns' };
      });
      build.onLoad({ filter: /.*/, namespace: 'shadcn-ns' }, () => ({
        contents: SHADCN_UI_SHIM, loader: 'js'
      }));

      // 5. Real local files in the workspace (@/ and relative).
      build.onResolve({ filter: /.*/ }, args => {
        if (args.path.startsWith('@/')) {
          const local = resolveAlias(args.path);
          if (local) return { path: local };
        } else if (args.path.startsWith('./') || args.path.startsWith('../')) {
          const candidate = path.resolve(args.resolveDir, args.path);
          if (isInside(projectRoot, candidate)) {
            const local = firstExisting(candidate);
            if (local) return { path: local };
          }
        }
        return null;
      });

      // 6. Shims of last resort. These run *after* the local-file resolver above,
      //    so a real file in the workspace always wins; they only catch paths that
      //    would otherwise fail the whole build.
      //
      //    "@/lib/utils" is the shadcn cn() helper — present in every real shadcn
      //    project, never written by the model, and imported by almost every
      //    component it generates.
      build.onResolve({ filter: /^@\/lib\// }, args => {
        note(args.path, 'helper');
        return { path: args.path, namespace: 'lib-ns' };
      });
      build.onLoad({ filter: /.*/, namespace: 'lib-ns' }, () => ({
        contents: CN_SHIM, loader: 'js'
      }));

      // Any other bare specifier — date-fns, clsx, @radix-ui/*, and whatever else
      // the model reaches for — resolves to a stub rather than an error.
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (args.path.indexOf('@/') === 0) return null; // a missing local file is a real bug
        // Absolute paths also start with a non-`.` character on Windows ("C:\..."),
        // so this filter catches esbuild's own entry point. Swallowing it handed the
        // whole app back as a stub: a 1.4 KB bundle where the real one was 209 KB,
        // with no error to show for it. Never claim a path that is a real file.
        if (path.isAbsolute(args.path)) return null;
        note(args.path, 'vendor');
        return { path: args.path, namespace: 'vendor-ns' };
      });
      build.onLoad({ filter: /.*/, namespace: 'vendor-ns' }, args => {
        if (args.path === 'date-fns') return { contents: DATE_FNS_SHIM, loader: 'js' };
        if (CN_PACKAGES.indexOf(args.path) !== -1) return { contents: CN_SHIM, loader: 'js' };
        return { contents: VENDOR_SHIM, loader: 'js' };
      });
    }
  };
}

/**
 * Bundles a generated React project, returning esbuild's result.
 * Throws esbuild's error (with `.errors`) on a failed build — callers decide
 * whether that is a preview to render or a diagnostic finding.
 */
async function bundleProject({ entryPath, srcDir, projectDir = null, onShimmed = null }) {
  return esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'HamaApp',
    logLevel: 'silent',
    // JSX was never configured, so the default *classic* transform was used: a
    // generated file that (correctly) omits `import React` died at mount with
    // "React is not defined", and JSX inside a `.js`/`.ts` entry — both of which
    // are in ENTRY_CANDIDATES — failed to parse outright.
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: { '.js': 'jsx', '.ts': 'tsx' },
    plugins: [makeSandboxPlugin({ srcDir, projectDir: projectDir || path.dirname(srcDir), onShimmed })]
  });
}

async function buildReactApp(chatId) {
  const chatDir = store.getChatWorkspaceDir(chatId);
  if (!chatDir || !fs.existsSync(chatDir)) return null;

  const files = scanFiles(chatDir);
  const entryFile = findEntry(chatDir, files);
  if (!entryFile) return null;

  const entryPath = path.join(chatDir, entryFile);
  const srcDir = fs.existsSync(path.join(chatDir, 'src')) ? path.join(chatDir, 'src') : chatDir;

  try {
    const result = await bundleProject({ entryPath, srcDir, projectDir: chatDir });

    const bundledJs = result.outputFiles[0].text;

    // Return complete, live HTML sandbox
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HAMA Live App Preview</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/prop-types@15.8.1/prop-types.min.js"></script>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/recharts@2.12.7/umd/Recharts.js"></script>
  <style>
    * { font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    #hama-root-error {
      display: none; margin: 20px; padding: 20px; border-radius: 12px;
      background: #fef2f2; border: 1px solid #f87171; color: #991b1b;
      font-family: monospace; font-size: 13px; white-space: pre-wrap;
    }
  </style>
</head>
<body class="bg-slate-50 text-slate-900 antialiased min-h-screen">
  <div id="hama-root-error"></div>
  <div id="root"></div>

  <script>
    window.onerror = function(msg, url, line, col, error) {
      const errBox = document.getElementById('hama-root-error');
      if (errBox) {
        errBox.style.display = 'block';
        errBox.textContent = 'Preview Runtime Error:\\n' + msg + '\\nat line ' + line + ':' + col;
      }
    };
  </script>

  <script>
${bundledJs.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')}
  </script>

  <script>
    try {
      const AppExport = window.HamaApp;
      const Component = (AppExport && AppExport.default) ? AppExport.default : AppExport;
      if (typeof Component === 'function') {
        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(Component));
      } else {
        // A project whose entry is src/main.tsx mounts itself from inside the
        // bundle and has no default export here. Writing the placeholder
        // unconditionally overwrote the app that had just rendered, which made
        // those previews flaky rather than merely wrong.
        const rootEl = document.getElementById('root');
        if (rootEl && !rootEl.firstChild) {
          rootEl.innerHTML = '<div style="padding:40px;text-align:center;color:#64748b;"><h3>App component not found</h3><p>Ensure App.tsx exports a default React component.</p></div>';
        }
      }
    } catch (e) {
      console.error(e);
      const errBox = document.getElementById('hama-root-error');
      if (errBox) {
        errBox.style.display = 'block';
        errBox.textContent = 'Mount Error: ' + e.message + '\\n' + e.stack;
      }
    }
  </script>
</body>
</html>`;
  } catch (err) {
    console.error('HAMA React Bundler Error:', err);
    // esbuild's message embeds the offending source line verbatim, so an
    // unescaped interpolation here let generated code close the <pre> and run
    // script in the preview's origin (which the harness API shares).
    const safeMessage = String(err && err.message ? err.message : err)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<!DOCTYPE html>
<html>
<body style="font-family:monospace;padding:24px;background:#0f172a;color:#f87171;line-height:1.6;">
  <h3 style="color:#ef4444;margin-top:0;">⚠️ Live React Preview Compilation Error</h3>
  <pre style="white-space:pre-wrap;background:#1e293b;padding:16px;border-radius:8px;color:#cbd5e1;">${safeMessage}</pre>
</body>
</html>`;
  }
}

module.exports = { buildReactApp, bundleProject, makeSandboxPlugin, findEntry, scanFiles };
