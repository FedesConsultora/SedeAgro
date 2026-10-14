const ACTIVE = new Set(['draft', 'pending_approval', 'approved', 'assigned', 'in_progress']);
const HIGH_PRIORITY = new Set(['high', 'urgent']);

export function filterWorkOrders(orders, { filter = 'all', search = '' } = {}) {
  const q = search.trim().toLocaleLowerCase('es-AR');
  return orders.filter(order => {
    const matchFilter = filter === 'all' ||
      (filter === 'attention' && ACTIVE.has(order.status) &&
        (HIGH_PRIORITY.has(order.priority) || order.status === 'pending_approval')) ||
      order.status === filter;
    if (!matchFilter) return false;
    const searchable = [order.title, order.Field?.name, order.type, order.instructions]
      .filter(Boolean).join(' ').toLocaleLowerCase('es-AR');
    return !q || searchable.includes(q);
  });
}

export function countWorkOrderFilters(orders) {
  return Object.fromEntries(['all', 'attention', 'assigned', 'in_progress', 'pending_approval', 'completed']
    .map(filter => [filter, filterWorkOrders(orders, { filter }).length]));
}
