import {Connection} from "../connection/Connection";
import {EntityMetadata} from "../metadata-builder/metadata/EntityMetadata";
import {QueryBuilder} from "../query-builder/QueryBuilder";
import {PlainObjectToNewEntityTransformer} from "../query-builder/transformer/PlainObjectToNewEntityTransformer";
import {PlainObjectToDatabaseEntityTransformer} from "../query-builder/transformer/PlainObjectToDatabaseEntityTransformer";
import {EntityPersistOperationBuilder} from "../persistment/EntityPersistOperationsBuilder";
import {PersistOperationExecutor} from "../persistment/PersistOperationExecutor";
import {EntityWithId} from "../persistment/operation/PersistOperation";

// todo: make extended functionality for findOne, find and findAndCount queries, so no need for user to use query builder

/**
 * Repository is supposed to work with your entity objects. Find entities, insert, update, delete, etc.
 */
export class Repository<Entity> {

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(private connection: Connection, private metadata: EntityMetadata) {
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Checks if entity has an id.
     */
    hasId(entity: Entity): boolean {
        return entity && this.metadata.primaryColumn && entity.hasOwnProperty(this.metadata.primaryColumn.propertyName);
    }

    /**
     * Creates a new query builder that can be used to build an sql query.
     */
    createQueryBuilder(alias: string): QueryBuilder<Entity> {
        return this.connection.driver
            .createQueryBuilder<Entity>()
            .select(alias)
            .from(this.metadata.target, alias);
    }

    /**
     * Creates a new entity. If fromRawEntity is given then it creates a new entity and copies all entity properties
     * from this object into a new entity (copies only properties that should be in a new entity).
     */
    create(fromRawEntity?: Object): Entity {
        if (fromRawEntity) {
            const transformer = new PlainObjectToNewEntityTransformer();
            return transformer.transform(fromRawEntity, this.metadata);
        }
        return <Entity> this.metadata.create();
    }

    /**
     * Creates a entities from the given array of plain javascript objects.
     */
    createMany(copyFromObjects: any[]): Entity[] {
        return copyFromObjects.map(object => this.create(object));
    }

    /**
     * Creates a new entity from the given plan javascript object. If entity already exist in the database, then
     * it loads it (and everything related to it), replaces all values with the new ones from the given object
     * and returns this new entity. This new entity is actually a loaded from the db entity with all properties
     * replaced from the new object.
     */
    initialize(object: Object): Promise<Entity> {
        const transformer = new PlainObjectToDatabaseEntityTransformer();
        const queryBuilder = this.createQueryBuilder(this.metadata.table.name);
        return transformer.transform(object, this.metadata, queryBuilder);
    }

    /**
     * Merges two entities into one new entity.
     */
    merge(entity1: Entity, entity2: Entity): Entity {
        return Object.assign(this.metadata.create(), entity1, entity2);
    }

    /**
     * Persists (saves) a given entity in the database.
     */
    persist(entity: Entity) {
        let loadedDbEntity: any;
        const persister = new PersistOperationExecutor(this.connection);
        const builder = new EntityPersistOperationBuilder(this.connection);
        const allPersistedEntities = this.extractObjectsById(entity, this.metadata);
        const promise = !this.hasId(entity) ? Promise.resolve(null) : this.initialize(entity);
        return promise
            .then(dbEntity => {
                loadedDbEntity = dbEntity;
                return this.findNotLoadedIds(this.extractObjectsById(dbEntity, this.metadata), allPersistedEntities);
            }) // need to find db entities that were not loaded by initialize method
            .then(allDbEntities => {
                const persistOperation = builder.buildFullPersistment(this.metadata, loadedDbEntity, entity, allDbEntities, allPersistedEntities);
                return persister.executePersistOperation(persistOperation);
            }).then(() => entity);
    }

    /**
     * Removes a given entity from the database.
     */
    remove(entity: Entity) {
        const persister = new PersistOperationExecutor(this.connection);
        return this.initialize(entity).then(dbEntity => {
            (<any> entity)[this.metadata.primaryColumn.name] = undefined;
            const builder = new EntityPersistOperationBuilder(this.connection);
            const dbEntities = this.extractObjectsById(dbEntity, this.metadata);
            const allPersistedEntities = this.extractObjectsById(entity, this.metadata);
            const persistOperation = builder.buildOnlyRemovement(this.metadata, dbEntity, entity, dbEntities, allPersistedEntities);
            return persister.executePersistOperation(persistOperation);
        }).then(() => entity);
    }

    /**
     * Finds entities that match given conditions.
     */
    find(conditions?: Object): Promise<Entity[]> {
        const alias = this.metadata.table.name;
        const builder = this.createQueryBuilder(alias);
        Object.keys(conditions).forEach(key => builder.where(alias + "." + key + "=:" + key));
        return builder.setParameters(conditions).getResults();
    }

    /**
     * Finds entities that match given conditions.
     */
    findAndCount(conditions?: Object): Promise<{ items: Entity[], count: number }> {
        const alias = this.metadata.table.name;
        const builder = this.createQueryBuilder(alias);
        if (conditions) {
            Object.keys(conditions).forEach(key => builder.where(alias + "." + key + "=:" + key));
            builder.setParameters(conditions);
        }
        return Promise.all<any>([ builder.getResults(), builder.getCount() ])
            .then(([entities, count]: [Entity[], number]) => ({ items: entities, count: count }));
    }

    /**
     * Finds first entity that matches given conditions.
     */
    findOne(conditions: Object): Promise<Entity> {
        const alias = this.metadata.table.name;
        const builder = this.createQueryBuilder(alias);
        Object.keys(conditions).forEach(key => builder.where(alias + "." + key + "=:" + key));
        return builder.setParameters(conditions).getSingleResult();
    }

    /**
     * Finds entity with given id.
     */
    findById(id: any): Promise<Entity> {
        const alias = this.metadata.table.name;
        return this.createQueryBuilder(alias)
            .where(alias + "." + this.metadata.primaryColumn.name + "=:id")
            .setParameter("id", id)
            .getSingleResult();
    }

    /**
     * Executes raw SQL query and returns raw database results.
     */
    query(query: string): Promise<any> {
        return this.connection.driver.query(query);
    }

    /**
     * Wraps given function execution (and all operations made there) in a transaction.
     */
    transaction(runInTransaction: () => Promise<any>): Promise<any> {
        let runInTransactionResult: any;
        return this.connection.driver
            .beginTransaction()
            .then(() => runInTransaction())
            .then(result => {
                runInTransactionResult = result;
                return this.connection.driver.endTransaction();
            })
            .then(() => runInTransactionResult);
    }

    // -------------------------------------------------------------------------
    // Private Methods
    // -------------------------------------------------------------------------

    /**
     * When ORM loads dbEntity it uses joins to load all entity dependencies. However when dbEntity is newly persisted
     * to the db, but uses already exist in the db relational entities, those entities cannot be loaded, and will
     * absent in dbEntities. To fix it, we need to go throw all persistedEntities we have, find out those which have
     * ids, check if we did not load them yet and try to load them. This algorithm will make sure that all dbEntities
     * are loaded. Further it will help insert operations to work correctly.
     */
    private findNotLoadedIds(dbEntities: EntityWithId[], persistedEntities: EntityWithId[]): Promise<EntityWithId[]> {
        const missingDbEntitiesLoad = persistedEntities
            .filter(entityWithId => entityWithId.id !== null && entityWithId.id !== undefined)
            .filter(entityWithId => !dbEntities.find(dbEntity => dbEntity.entity.constructor === entityWithId.entity.constructor && dbEntity.id === entityWithId.id))
            .map(entityWithId => {
                const metadata = this.connection.getMetadata(entityWithId.entity.constructor);
                const repository = this.connection.getRepository(entityWithId.entity.constructor);
                return repository.findById(entityWithId.id).then(loadedEntity => {
                    if (!loadedEntity) return undefined;

                    return {
                        id: (<any> loadedEntity)[metadata.primaryColumn.name],
                        entity: loadedEntity
                    };
                });
            });

        return Promise.all(missingDbEntitiesLoad).then(missingDbEntities => {
            return dbEntities.concat(missingDbEntities.filter(dbEntity => !!dbEntity));
        });
    }

    /**
     * Extracts unique objects from given entity and all its downside relations.
     */
    private extractObjectsById(entity: any, metadata: EntityMetadata, entityWithIds: EntityWithId[] = []): EntityWithId[] {
        if (!entity)
            return entityWithIds;

        metadata.relations
            .filter(relation => !!entity[relation.propertyName])
            .forEach(relation => {
                const relMetadata = relation.relatedEntityMetadata;
                const value = entity[relation.propertyName];
                if (value instanceof Array) {
                    value.forEach((subEntity: any) => this.extractObjectsById(subEntity, relMetadata, entityWithIds));
                } else {
                    this.extractObjectsById(value, relMetadata, entityWithIds);
                }
            });
        
        if (!entityWithIds.find(entityWithId => entityWithId.entity === entity)) {
            entityWithIds.push({
                id: entity[metadata.primaryColumn.name],
                entity: entity
            });
        }
        
        return entityWithIds;
    }

}