import { HttpStatus, Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CreateOrderDto } from './dto/create-order.dto';
import { PrismaClient } from '@prisma/client';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { OrderPaginationDto } from './dto/order-pagination.dto';
import { ChangeOrderStatusDto } from './dto/change-order-status.dto';
import { NATS_SERVICE, PRODUCT_SERVICE } from 'src/config/services';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class OrdersService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger('OrdersService')

  constructor(@Inject(NATS_SERVICE) private readonly client: ClientProxy){
    super()
  }
  

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Connected to database');

  }


  async create(createOrderDto: CreateOrderDto) {


    try {
      //1. Confirmar ids de los productos
      const productsIds = createOrderDto.items.map( item => item.productId);
  
      const pattern = {cmd: 'validate_products'}
      const products = await firstValueFrom(
        this.client.send(pattern, productsIds)
      );

      //2. Cálculo de los valores
      const totalAmount = createOrderDto.items.reduce((acc, orderItem) =>{
        const price = products.find(product => product.id === orderItem.productId).price;

        return acc + (price * orderItem.quantity);

      }, 0)


      const totalItem = createOrderDto.items.reduce((acc, orderItem) =>{
        return acc + orderItem.quantity;
      }, 0);

      //3. Crear una transaccion de base de datos
      const order = await this.order.create({
        data: {
          totalAmount: totalAmount,
          totalItems: totalItem,
          OrderItem: {
            createMany: {
              data: createOrderDto.items.map((orderItem) => ({
                productId: orderItem.productId,
                price: products.find(product => product.id === orderItem.productId).price,
                quantity: orderItem.quantity
              }))
            }
          }
        },
        include: {
          OrderItem: {
            select: {
              productId: true,
              quantity: true,
              price: true
            }
          }
        }
      })
  
      return {
        ...order,
        OrderItem: order.OrderItem.map((orderItem)=>({
          ...orderItem,
          name: products.find( product => product.id === orderItem.productId).name
        }))
      }
      
    } catch (error) {
      throw new RpcException({
        status: HttpStatus.BAD_REQUEST,
        message: 'Check logs'
      });
    }

  }

  async findAll(orderPaginationDto: OrderPaginationDto) {
    const { limit, page, status } = orderPaginationDto;

    const totalPages = await this.order.count({ where: { status } });

    const lastPage = Math.ceil(totalPages / limit)

    return {
      data: await this.order.findMany({
        where: { status },
        skip: (page - 1) * limit,
        take: limit
      }),
      meta: {
        page: page,
        total: totalPages,
        lastPage: lastPage
      }
    }
  }

  async findOne(id: string) {

    const order = await this.order.findFirst({
      where: {
        id
      },
      include: {
          OrderItem: {
            select: {
              productId: true,
              quantity: true,
              price: true
            }
          }
    }})

    if (!order) {
      throw new RpcException(
        {
          status: HttpStatus.NOT_FOUND,
          message: `Order with id ${id} not found`
        }
      );
    }

    const productsIds = order.OrderItem.map(orderItem => orderItem.productId);
    const pattern = {cmd: 'validate_products'}
    const products = await firstValueFrom(
        this.client.send(pattern, productsIds)
    );

    return {
        ...order,
        OrderItem: order.OrderItem.map((orderItem)=>({
          ...orderItem,
          name: products.find( product => product.id === orderItem.productId).name
        }))
      }
  }

  async changeStatus(changeOrderStatusDto: ChangeOrderStatusDto) {
    const { id, status } = changeOrderStatusDto;

    const order = await this.findOne(id);

    if (order.status === status) {
      return order;
    }

    return this.order.update({ where: { id }, data: { status: status } });
  }
}
