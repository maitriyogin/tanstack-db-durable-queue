# BFF Todos - NestJS GraphQL Backend

A modern GraphQL backend for managing todos using **NestJS** with **Code-First** approach, Prisma ORM, and SQLite database.

## Architecture

```
GraphQL Layer (Code-First with Decorators)
    ↓
Resolver Layer (@Resolver, @Query, @Mutation)
    ↓
Service Layer (@Injectable)
    ↓
DAO Layer (@Injectable)
    ↓
Prisma Client
    ↓
SQLite Database
```

### Key Technologies

- **[NestJS](https://nestjs.com/)** - Progressive Node.js framework with:
  - Dependency injection
  - Module-based architecture
  - Decorator-based development
  - Built-in validation
- **GraphQL Code-First** - Schema generated from TypeScript classes with decorators
- **Prisma** - Type-safe ORM
- **SQLite** - Database
- **Class Validator** - Input validation
- **Class Transformer** - Object transformation

## Project Structure

```
src/
├── models/               # GraphQL Object Types (@ObjectType)
│   └── todo.model.ts
├── inputs/               # GraphQL Input Types (@InputType)
│   └── todo.input.ts
├── resolvers/            # GraphQL Resolvers (@Resolver)
│   └── todo.resolver.ts
├── services/             # Business logic layer (@Injectable)
│   └── todo.service.ts
├── dao/                  # Data Access Layer (@Injectable)
│   └── todos.dao.ts
├── prisma/               # Prisma service
│   └── prisma.service.ts
├── todos/                # Todos Module
│   └── todos.module.ts
├── app.module.ts         # Root module with GraphQL configuration
└── main.ts               # NestJS bootstrap

prisma/
└── schema.prisma         # Prisma schema definition

src/schema.gql            # Auto-generated GraphQL schema
```

## NestJS Code-First Approach

### Object Type Definition
```typescript
@ObjectType()
export class Todo {
  @Field(() => ID)
  id: string;

  @Field()
  name: string;

  @Field()
  status: string;
}
```

### Input Type with Validation
```typescript
@InputType()
export class CreateTodoInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  name: string;

  @Field()
  @IsNotEmpty()
  @IsString()
  status: string;
}
```

### Resolver with Decorators
```typescript
@Resolver(() => Todo)
export class TodoResolver {
  constructor(private readonly todoService: TodoService) {}

  @Query(() => [Todo])
  async todos(): Promise<Todo[]> {
    return await this.todoService.listTodos();
  }

  @Mutation(() => Todo)
  async createTodo(@Args('input') input: CreateTodoInput): Promise<Todo> {
    return await this.todoService.createTodo(input);
  }
}
```

### Dependency Injection
```typescript
@Injectable()
export class TodoService {
  constructor(private readonly todosDao: TodosDao) {}
}
```

## Setup

1. Install dependencies:
```bash
pnpm install
```

2. Generate Prisma client:
```bash
pnpm run prisma:generate
```

3. Run database migrations:
```bash
pnpm run prisma:migrate
```

4. Start the development server:
```bash
pnpm run dev
# or
pnpm run start:dev
```

The GraphQL server will be available at: `http://localhost:4000/graphql`

## GraphQL Operations

### Queries

**Get all todos:**
```graphql
query {
  todos {
    id
    name
    description
    status
    createdAt
    updatedAt
  }
}
```

**Get a single todo:**
```graphql
query {
  todo(id: "todo-id") {
    id
    name
    description
    status
  }
}
```

### Mutations

**Create a todo:**
```graphql
mutation {
  createTodo(input: {
    name: "Learn NestJS"
    description: "Study NestJS with GraphQL code-first"
    status: "pending"
  }) {
    id
    name
    description
    status
  }
}
```

**Update a todo:**
```graphql
mutation {
  updateTodo(input: {
    id: "todo-id"
    status: "completed"
  }) {
    id
    name
    status
  }
}
```

**Delete a todo:**
```graphql
mutation {
  deleteTodo(id: "todo-id") {
    id
    name
  }
}
```

## Todo Schema

- `id`: Unique identifier (UUID)
- `name`: Todo name
- `description`: Todo description
- `status`: Todo status (e.g., "pending", "in-progress", "completed")
- `createdAt`: Creation timestamp
- `updatedAt`: Last update timestamp

## Development Commands

- `pnpm run dev` - Start development server with hot reload
- `pnpm run start:dev` - Start development server (alternative)
- `pnpm run build` - Build for production
- `pnpm run start:prod` - Start production server
- `pnpm run prisma:generate` - Generate Prisma client
- `pnpm run prisma:migrate` - Run database migrations
- `pnpm run prisma:studio` - Open Prisma Studio (database GUI)

## Benefits of NestJS Code-First

1. **Type Safety**: GraphQL schema generated from TypeScript types
2. **Validation**: Built-in validation with class-validator decorators
3. **Dependency Injection**: Clean, testable architecture
4. **Modularity**: Feature-based module organization
5. **Auto-documentation**: Schema is always in sync with code
6. **Developer Experience**: Strong IDE support with decorators
7. **Scalability**: Enterprise-ready framework structure

## Auto-Generated Schema

The GraphQL schema is automatically generated at `src/schema.gql` from your TypeScript classes and decorators. This ensures:
- Schema always matches implementation
- No manual schema maintenance
- Type-safe resolvers
- Compile-time error checking
