import { CatalogController } from './catalog.controller';
import type { CatalogService } from './catalog.service';
import type { Catalog, PaginatedProducts, Product } from '../../engine/interfaces/whatsapp-engine.interface';

/**
 * The controller is a thin map from route params/DTOs onto CatalogService's positional arguments.
 * What is worth pinning here is the wiring itself (which field lands in which argument slot).
 */
describe('CatalogController', () => {
  const service = {
    getCatalog: jest.fn(),
    getProducts: jest.fn(),
    getProduct: jest.fn(),
    sendProduct: jest.fn(),
  };
  const controller = new CatalogController(service as unknown as CatalogService);

  beforeEach(() => jest.clearAllMocks());

  it('getCatalog forwards the session id', async () => {
    const catalog = { id: 'cat-1' } as Catalog;
    service.getCatalog.mockResolvedValue(catalog);

    await expect(controller.getCatalog('s1')).resolves.toBe(catalog);
    expect(service.getCatalog).toHaveBeenCalledWith('s1');
  });

  it('getProducts forwards the parsed page window, not the query object', async () => {
    const page: PaginatedProducts = { products: [], pagination: { page: 2, limit: 10, total: 0, totalPages: 0 } };
    service.getProducts.mockResolvedValue(page);

    await expect(controller.getProducts('s1', { page: 2, limit: 10 })).resolves.toBe(page);
    expect(service.getProducts).toHaveBeenCalledWith('s1', 2, 10);
  });

  it('getProduct forwards the product id from the route', async () => {
    const product = { id: 'prod-1' } as Product;
    service.getProduct.mockResolvedValue(product);

    await expect(controller.getProduct('s1', 'prod-1')).resolves.toBe(product);
    expect(service.getProduct).toHaveBeenCalledWith('s1', 'prod-1');
  });

  it('sendProduct maps the DTO onto the service’s positional arguments', async () => {
    const sent = { id: 'wamid.product', timestamp: 1_706_868_000 };
    service.sendProduct.mockResolvedValue(sent);

    const dto = { chatId: '628123@c.us', productId: 'prod-1', body: 'Back in stock!' };
    await expect(controller.sendProduct('s1', dto)).resolves.toBe(sent);
    expect(service.sendProduct).toHaveBeenCalledWith('s1', '628123@c.us', 'prod-1', 'Back in stock!');
  });
});
